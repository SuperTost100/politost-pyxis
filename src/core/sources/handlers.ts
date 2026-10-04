import { fetchSnapshot } from "./link";
import { readBlob } from "../blobs";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type Database from "better-sqlite3";
import { IpcError } from "../../shared/ipc";
import { importDocumentFile } from "./documents";
import {
  downloadModel,
  embeddingReady,
  embedTexts,
  indexModelVectors,
  embeddingConsent,
  setEmbeddingConsent,
} from "./embed";
import type { Runner } from "../jobs/runner";
import {
  enqueueSourceFile,
  enqueueSourceData,
  registerSourceJobs,
} from "./jobs";
import { retrieveWithModel, setRetrievalModel } from "./retrieve";
import { PASTE_MIN } from "./paste";
import { listImportable } from "./folder";
import { importImageFile, importLink, isImageExt, ocrPngPage } from "./intake";
import {
  promoteSource,
  removeSource,
  renameSource,
  replaceSourceFile,
} from "./manage";
import { requestOcr } from "./ocr";
import { importPastedText } from "./paste";
import { runSourceWorker } from "./worker-client";
import { isHeicExt, MAX_HEIC_BYTES } from "./heic";
import { imageVariance, recognizeImage } from "./recognize";
import { isDuplicateBlob, qualityFlags, sha256 } from "./quality";
import {
  chapterPassages,
  importSmartbookFile,
  listSources,
  passagesAround,
  searchPassages,
  smartbookChapters,
  smartbookMeta,
  sourcePassages,
} from "./smartbook";

function sourceError(err: unknown): never {
  const message = err instanceof Error ? err.message : "";
  const key: Record<string, string> = {
    "encrypted-smartbook": "sources.encrypted",
    "licensed-smartbook": "sources.encrypted",
    "paste-short": "sources.pasteShort",
    "page-empty": "sources.pageEmpty",
    "link-scheme": "sources.linkScheme",
    "link-failed": "sources.linkFailed",
    "link-timeout": "sources.linkFailed",
    "link-redirect": "sources.linkFailed",
    "link-too-big": "sources.linkFailed",
    "heic-invalid": "sources.importFailed",
    "heic-too-large": "sources.importFailed",
    "heic-decoder-unavailable": "sources.importFailed",
    "embed-hash": "sources.embedHash",
    "embed-unpinned": "sources.embedHash",
    "source-missing": "sources.importFailed",
    "source-busy": "sources.busy",
    "title-empty": "sources.titleEmpty",
  };
  const messageKey = key[message];
  if (message === "encrypted-smartbook" || message === "licensed-smartbook") {
    throw new IpcError("unsupported", "sources.encrypted");
  }
  if (messageKey) throw new IpcError("invalid-output", messageKey, {}, message);
  throw new IpcError("invalid-output", "sources.importFailed", {}, message);
}

export function sourceHandlers(
  db: Database.Database,
  workspace: string,
  runner?: Runner,
  readPickedFile: (path: string) => Buffer = readFileSync,
) {
  const modelDir = join(workspace, "models", "e5");
  setRetrievalModel(async (text, signal) => {
    if (!embeddingConsent(db) || !embeddingReady(modelDir)) return null;
    return (await embedTexts(modelDir, [text], signal))[0] ?? null;
  });
  if (runner) {
    db.prepare(
      `UPDATE sources SET status = 'interrupted' WHERE status NOT IN ('removed', 'ready')
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'source-import' AND j.state = 'interrupted'
      AND json_extract(j.params_json, '$.sourceId') = sources.id)`,
    ).run();
    registerSourceJobs(db, workspace, runner);
    runner.register("source-index", {
      jobClass: "local",
      steps: [
        {
          name: "index",
          label: "sources.jobs.vectors",
          async run(ctx) {
            if (!embeddingConsent(db) || !embeddingReady(modelDir))
              return { count: 0 };
            return {
              count: await indexModelVectors(
                db,
                modelDir,
                ctx.signal,
                (ctx.params as { sourceId: string }).sourceId,
              ),
            };
          },
        },
      ],
    });
    runner.register("embedding-download", {
      jobClass: "local",
      steps: [
        {
          name: "download",
          label: "sources.jobs.download",
          async run(ctx) {
            if (!embeddingConsent(db)) throw new Error("embed-declined");
            await downloadModel(modelDir, ctx.signal);
            return { ready: true };
          },
        },
        {
          name: "index",
          label: "sources.jobs.vectors",
          async run(ctx) {
            return { count: await indexModelVectors(db, modelDir, ctx.signal) };
          },
        },
      ],
    });
  }
  const tess = join(workspace, "runtimes", "tesseract");
  return {
    async linkPreview(input: { url: string }, signal?: AbortSignal) {
      try {
        const snapshot = await fetchSnapshot(
          input.url,
          undefined,
          undefined,
          signal,
        );
        return {
          title: snapshot.title,
          excerpt: snapshot.markdown.slice(0, 400),
          kind: snapshot.pdf ? ("pdf" as const) : ("web" as const),
          bytes: snapshot.pdf?.byteLength ?? null,
        };
      } catch (error) {
        sourceError(error);
      }
    },
    list() {
      return listSources(db).map((source) => {
        let bytes: number | null = null;
        if (source.blobSha) {
          try {
            bytes = statSync(readBlob(workspace, source.blobSha).file).size;
          } catch {
            /* Missing original is shown without an invented size. */
          }
        }
        return { ...source, bytes };
      });
    },
    async importFile(input: { path: string }) {
      try {
        if (runner)
          return await enqueueSourceFile(db, workspace, runner, input.path);
        const ext = extname(input.path).toLowerCase();
        if (ext === ".ptsb")
          return importSmartbookFile(db, workspace, input.path);
        if (isImageExt(ext))
          return await importImageFile(db, workspace, input.path);
        return await importDocumentFile(db, workspace, input.path);
      } catch (err) {
        sourceError(err);
      }
    },
    paste(input: { title: string; text: string }) {
      try {
        if (runner) {
          const text = input.text.replace(/\r\n/g, "\n").trim();
          if (text.length < PASTE_MIN) throw new Error("paste-short");
          return enqueueSourceData(
            db,
            workspace,
            runner,
            new TextEncoder().encode(text),
            ".txt",
            input.title.trim() || "Notes",
          );
        }
        return importPastedText(db, workspace, input.title, input.text);
      } catch (err) {
        sourceError(err);
      }
    },
    async link(input: { url: string }) {
      try {
        if (runner) {
          const url = new URL(input.url);
          if (!["http:", "https:"].includes(url.protocol))
            throw new Error("link-scheme");
          return enqueueSourceData(
            db,
            workspace,
            runner,
            new Uint8Array(),
            ".md",
            url.hostname,
            url.href,
          );
        }
        return await importLink(db, workspace, input.url);
      } catch (err) {
        sourceError(err);
      }
    },
    scanFolder(input: { path: string }) {
      return listImportable(input.path).map((file) => {
        const bytes = new Uint8Array(readPickedFile(file));
        return {
          path: file,
          name: basename(file),
          duplicate: isDuplicateBlob(db, sha256(bytes)),
        };
      });
    },
    async preview(input: { path: string }) {
      try {
        const ext = extname(input.path);
        if (isHeicExt(ext) && statSync(input.path).size > MAX_HEIC_BYTES)
          throw new Error("heic-too-large");
        const bytes = new Uint8Array(readFileSync(input.path));
        const flags = qualityFlags({
          duplicate: isDuplicateBlob(db, sha256(bytes)),
          variance: isHeicExt(ext)
            ? await runSourceWorker<number | null>("extract-worker", { path: input.path, ext: ext.toLowerCase(), mode: "quality" })
            : imageVariance(bytes, ext),
        });
        return {
          duplicate: flags.includes("duplicate"),
          blurry: flags.includes("blurry"),
        };
      } catch (err) {
        sourceError(err);
      }
    },
    rename(input: { sourceId: string; title: string }) {
      try {
        renameSource(db, input.sourceId, input.title);
        return { ok: true as const };
      } catch (err) {
        sourceError(err);
      }
    },
    async replace(input: { sourceId: string; path: string }) {
      try {
        if (runner)
          return await enqueueSourceFile(
            db,
            workspace,
            runner,
            input.path,
            input.sourceId,
          );
        const result = await replaceSourceFile(
          db,
          workspace,
          input.sourceId,
          input.path,
        );
        return result;
      } catch (err) {
        sourceError(err);
      }
    },
    promote(input: { sourceId: string }) {
      try {
        promoteSource(db, input.sourceId);
        return { ok: true as const };
      } catch (err) {
        sourceError(err);
      }
    },
    remove(input: { sourceId: string; confirmed: boolean }) {
      try {
        return removeSource(db, input.sourceId, input.confirmed);
      } catch (err) {
        sourceError(err);
      }
    },
    async ocrImage(input: {
      sourceId: string;
      pngBase64: string;
      page: number;
      last: boolean;
    }) {
      try {
        const png = Buffer.from(input.pngBase64, "base64");
        const status = await ocrPngPage(
          db,
          input.sourceId,
          input.page,
          png,
          (bytes) => recognizeImage(bytes, tess),
          input.last,
        );
        if (
          runner &&
          status === "ready" &&
          embeddingConsent(db) &&
          embeddingReady(modelDir)
        )
          runner.start("source-index", { sourceId: input.sourceId });
        return { status };
      } catch (err) {
        sourceError(err);
      }
    },
    embedState() {
      return { consent: embeddingConsent(db), ready: embeddingReady(modelDir) };
    },
    async embed(input: { consent: boolean }) {
      setEmbeddingConsent(db, input.consent);
      if (!input.consent) return { state: "off" as const };
      if (!runner) throw new IpcError("not-ready", "errors.notReady");
      const jobId = runner.start("embedding-download");
      return { state: "missing" as const, jobId };
    },
    async search(input: { query: string }, signal?: AbortSignal) {
      return (await retrieveWithModel(db, input.query, { signal })).hits;
    },
    chapters(input: { sourceId: string }) {
      return smartbookChapters(db, input.sourceId);
    },
    meta(input: { sourceId: string }) {
      return smartbookMeta(db, input.sourceId);
    },
    ocr(input: { sourceId: string }) {
      requestOcr(db, input.sourceId);
      return { status: "ocr-queued" as const };
    },
    passage(input: { passageId: string }) {
      return passagesAround(db, input.passageId);
    },
    viewerDocument(input: { sourceId?: string; passageId?: string }) {
      const row = db
        .prepare(
          `SELECT s.id, s.title, s.kind, s.blob_sha, d.tree_json, d.version,
        (SELECT MAX(version) FROM source_documents WHERE source_id = s.id) AS latest
        FROM sources s LEFT JOIN source_documents d ON d.id = COALESCE(
          (SELECT document_id FROM passages WHERE id = ?),
          (SELECT id FROM source_documents WHERE source_id = s.id ORDER BY version DESC LIMIT 1))
        WHERE s.id = COALESCE((SELECT source_id FROM passages WHERE id = ?), ?)`,
        )
        .get(
          input.passageId ?? null,
          input.passageId ?? null,
          input.sourceId ?? null,
        ) as
        | {
            id: string;
            title: string;
            kind: string;
            blob_sha: string | null;
            tree_json: string | null;
            version: number;
            latest: number;
          }
        | undefined;
      if (!row) return null;
      const tree = row.tree_json
        ? (JSON.parse(row.tree_json) as { blobSha?: string; kind?: string })
        : {};
      return {
        sourceId: row.id,
        title: row.title,
        kind: tree.kind ?? row.kind,
        blobSha:
          tree.blobSha ?? (row.version === row.latest ? row.blob_sha : null),
        excerpt: input.passageId
          ? ((
              db
                .prepare("SELECT text FROM passages WHERE id = ?")
                .get(input.passageId) as { text: string } | undefined
            )?.text ?? null)
          : null,
      };
    },
    chapter(input: { sourceId: string; chapter: number; paragraph?: string }) {
      const rows =
        smartbookChapters(db, input.sourceId).length === 0
          ? sourcePassages(db, input.sourceId)
          : chapterPassages(db, input.sourceId, input.chapter);
      return rows.map((row) => ({
        ...row,
        sourceId: input.sourceId,
        current: input.paragraph
          ? row.locator.paragraph === input.paragraph
          : false,
      }));
    },
  };
}
