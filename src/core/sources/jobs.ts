import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { putBlob, readBlob } from "../blobs";
import type { Runner } from "../jobs/runner";
import { addDocumentVersion, kindFor, mimeFor, storeExtracted, type ExtractedDocument } from "./documents";
import { embeddingConsent, embeddingReady, indexModelVectors } from "./embed";
import { storeSmartbook, type ParsedSmartbook } from "./smartbook";
import { runSourceWorker } from "./worker-client";
import { fetchSnapshot } from "./link";

type ImportParams = { sourceId: string; sha: string; ext: string; title: string; extractedSha?: string; url?: string; fetched?: boolean; replace?: boolean; version: number };
export type Extraction = { book?: ParsedSmartbook; document?: ExtractedDocument };

export function registerSourceJobs(db: Database.Database, workspace: string, runner: Runner,
  extract = (input: { path: string; ext: string; tess: string }, signal: AbortSignal) => runSourceWorker<Extraction>("extract-worker", input, signal)): void {
  const modelDir = join(workspace, "models", "e5");
  runner.register("source-import", {
    jobClass: "local",
    steps: [
      { name: "extract", label: "sources.jobs.extract", async run(ctx) {
        let input = ctx.params as ImportParams;
        db.prepare(`UPDATE sources SET status = 'extracting' WHERE id = ? AND status != 'removed'`).run(input.sourceId);
        if (input.url && !input.fetched) {
          const page = await fetchSnapshot(input.url, (url, options) => fetch(url, {
            ...options, signal: options?.signal ? AbortSignal.any([options.signal, ctx.signal]) : ctx.signal,
          }));
          ctx.signal.throwIfAborted();
          const ext = page.pdf ? ".pdf" : ".md";
          const sha = putBlob(workspace, page.pdf ?? new TextEncoder().encode(page.markdown), mimeFor(ext), ext.slice(1));
          input = { ...input, sha, ext, title: page.title, fetched: true };
          db.transaction(() => {
            db.prepare(`UPDATE sources SET blob_sha = ?, mime = ?, kind = ?, title = ?, origin_url = ?, fetched_at = ? WHERE id = ? AND status != 'removed'`)
              .run(sha, mimeFor(ext), page.pdf ? "pdf" : "link", page.title, page.finalUrl, Date.now(), input.sourceId);
            ctx.setParams(input);
          })();
        }
        const value = await extract({
          path: readBlob(workspace, input.sha).file, ext: input.ext, tess: join(workspace, "runtimes", "tesseract"),
        }, ctx.signal);
        ctx.signal.throwIfAborted();
        const extractedSha = putBlob(workspace, Buffer.from(JSON.stringify(value)), "application/json", "json");
        ctx.setParams({ ...input, extractedSha });
        return { extractedSha };
      } },
      { name: "passages", label: "sources.jobs.passages", async run(ctx) {
        const input = ctx.params as ImportParams;
        const value = JSON.parse(await readFile(readBlob(workspace, input.extractedSha!).file, "utf8")) as Extraction;
        ctx.signal.throwIfAborted();
        const bytes = new Uint8Array(await readFile(readBlob(workspace, input.sha).file));
        ctx.signal.throwIfAborted();
        db.transaction(() => {
          const source = db.prepare(`SELECT status FROM sources WHERE id = ?`).get(input.sourceId) as { status: string } | undefined;
          if (!source || source.status === "removed") throw new Error("source-missing");
          // The source and checkpoint commit together. Restart cannot duplicate passages.
          if (!db.prepare(`SELECT 1 FROM source_documents WHERE source_id = ? AND version = ?`).get(input.sourceId, input.version)) {
            if (value.book) storeSmartbook(db, value.book, Date.now(), input.sourceId);
            else if (value.document && input.replace) addDocumentVersion(db, workspace, input.sourceId, {
              title: input.title, mime: mimeFor(input.ext), ext: input.ext, bytes, extracted: value.document,
            });
            else if (value.document) storeExtracted(db, workspace, {
              sourceId: input.sourceId, title: input.title,
              kind: [".png", ".jpg", ".jpeg", ".webp"].includes(input.ext) ? "image" : kindFor(input.ext),
              mime: [".png", ".jpg", ".jpeg", ".webp"].includes(input.ext) ? `image/${input.ext === ".jpg" ? "jpeg" : input.ext.slice(1)}` : mimeFor(input.ext),
              ext: input.ext, bytes, extracted: value.document,
            });
            else throw new Error("extraction-failed");
          }
          ctx.setParams(input);
        })();
        return { sourceId: input.sourceId };
      } },
      { name: "vectors", label: "sources.jobs.vectors", async run(ctx) {
        const input = ctx.params as ImportParams;
        if (embeddingConsent(db) && embeddingReady(modelDir)) {
          db.prepare(`UPDATE sources SET status = 'indexing' WHERE id = ? AND status != 'removed'`).run(input.sourceId);
          await indexModelVectors(db, modelDir, ctx.signal, input.sourceId);
        }
        ctx.signal.throwIfAborted();
        const extracted = JSON.parse(await readFile(readBlob(workspace, input.extractedSha!).file, "utf8")) as Extraction;
        db.prepare(`UPDATE sources SET status = ? WHERE id = ? AND status != 'removed'`)
          .run(extracted.document?.scanned ? "needs-ocr" : "ready", input.sourceId);
        return { sourceId: input.sourceId };
      } },
    ],
  });
}

export async function enqueueSourceFile(db: Database.Database, workspace: string, runner: Runner, path: string, existingId?: string) {
  const bytes = new Uint8Array(await readFile(path));
  const ext = extname(path).toLowerCase();
  if (existingId && ![".pdf", ".docx", ".pptx", ".txt", ".md"].includes(ext)) throw new Error("unsupported-file");
  return enqueueSourceData(db, workspace, runner, bytes, ext, basename(path, ext), undefined, existingId);
}

export function enqueueSourceData(db: Database.Database, workspace: string, runner: Runner,
  bytes: Uint8Array, ext: string, title: string, url?: string, existingId?: string) {
  if (![".ptsb", ".pdf", ".docx", ".pptx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    throw new Error("unsupported-file");
  }
  const sourceId = existingId ?? uuidv7();
  const kind = url ? "link" : ext === ".ptsb" ? "smartbook" : [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? "image" : kindFor(ext);
  const mime = kind === "smartbook" ? "application/vnd.politost.ptsb" : kind === "image" ? `image/${ext === ".jpg" ? "jpeg" : ext.slice(1)}` : mimeFor(ext);
  const sha = putBlob(workspace, bytes, mime, ext.slice(1));
  const jobId = db.transaction(() => {
    if (existingId) {
      if (!db.prepare(`SELECT 1 FROM sources WHERE id = ? AND status != 'removed'`).get(existingId)) throw new Error("source-missing");
      if (db.prepare(`SELECT 1 FROM jobs WHERE json_extract(params_json, '$.sourceId') = ?
        AND state IN ('running', 'queued', 'failed', 'cancelled', 'interrupted')`).get(existingId)) throw new Error("source-busy");
      db.prepare(`UPDATE sources SET status = 'queued', updated_at = ? WHERE id = ?`).run(Date.now(), existingId);
    } else {
      db.prepare(`INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(sourceId, kind, title, sha, mime, Date.now(), Date.now());
    }
    const version = (db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`).get(sourceId) as { n: number }).n;
    return runner.start("source-import", { sourceId, sha, ext, title, url, version, replace: Boolean(existingId) } satisfies ImportParams);
  })();
  return { sourceId, jobId, title, chapters: 0, passages: 0, exercises: 0 };
}
