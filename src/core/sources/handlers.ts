import { fetchSnapshot } from "./link";
import { readBlob } from "../blobs";
import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type Database from "better-sqlite3";
import { IpcError, isAbort } from "../../shared/ipc";
import { importDocumentFile, type Extractor } from "./documents";
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
  enqueueReextract,
  enqueueSourceFile,
  enqueueSourceData,
  assertLocalOcrReady,
  registerSourceJobs,
} from "./jobs";
import { retrieveWithModel, setRetrievalModel } from "./retrieve";
import { PASTE_MIN } from "./paste";
import { listImportable, MAX_FOLDER_FILES } from "./folder";
import { importImageFile, importLink, isImageExt, ocrPngPage } from "./intake";
import {
  extForMime,
  promoteSource,
  removeSource,
  renameSource,
  replaceSourceFile,
} from "./manage";
import { requestOcr, stopOcr } from "./ocr";
import {
  downloadOcrLanguage,
  OCR_LANGUAGES,
  ocrConsent,
  ocrDataStatus,
  setOcrConsent,
  sweepStaleOcrScratch,
} from "./ocr-data";
import { importPastedText } from "./paste";
import { runSourceWorker } from "./worker-client";
import { sniffImage } from "./vision-image";
import { isDuplicateBlob, qualityFlags } from "./quality";
import { compareToPlans, storedSyllabus, syllabusFor } from "./syllabus";
import { maxSourceBytes, MAX_IMAGE_BASE64, MAX_IMAGE_BYTES, MAX_SOURCE_BYTES } from "../../shared/source-types";
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
    "source-too-big": "sources.tooBig",
    "source-changed": "sources.changed",
    "source-unreadable": "sources.unreadable",
    "vision-image-unsupported": "sources.imageUnsupported",
    "vision-image-too-large": "sources.imageTooLarge",
    "heic-decoder-unavailable": "sources.importFailed",
    "ocr-data-missing": "sources.ocrDataMissing",
    "ocr-data-integrity": "sources.ocrDataIntegrity",
    "ocr-data-offline": "sources.ocrDataOffline",
    "ocr-data-download": "sources.ocrDataOffline",
    "ocr-data-too-big": "sources.ocrDataIntegrity",
    "ocr-data-declined": "sources.ocrDataMissing",
    "embed-hash": "sources.embedHash",
    "embed-unpinned": "sources.embedHash",
    "source-missing": "sources.importFailed",
    "source-file-missing": "sources.fileMissing",
    "ocr-out-of-order": "sources.ocrInterrupted",
    "ocr-not-active": "sources.ocrInterrupted",
    "ocr-stale": "sources.ocrInterrupted",
    "source-busy": "sources.busy",
    "reextract-unavailable": "sources.reextractUnavailable",
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
  /** Checks a listed file against the folder grant. Returns the path to read, or throws. */
  authorizeFile: (path: string) => string = (path) => path,
  work: typeof runSourceWorker = runSourceWorker,
) {
  const modelDir = join(workspace, "models", "e5");
  const tess = join(workspace, "runtimes", "tesseract");
  // Folders an earlier process left while reading a photo, from a crash or a quit mid-OCR.
  sweepStaleOcrScratch(tess);
  // A scan reads one page per request from the renderer, so no run can outlive this process. One still queued was cut off
  // by a quit or a crash; it goes back to needs-ocr with its pages kept, so it can be started again.
  stopOcr(db);
  setRetrievalModel(async (text, signal) => {
    if (!embeddingConsent(db) || !embeddingReady(modelDir)) return null;
    return (await embedTexts(modelDir, [text], signal))[0] ?? null;
  });
  if (runner) {
    db.prepare(
      `UPDATE sources SET status = 'interrupted' WHERE status NOT IN ('removed', 'ready')
      AND EXISTS (SELECT 1 FROM jobs j WHERE j.kind IN ('source-import', 'source-import-vision') AND j.state = 'interrupted'
      AND json_extract(j.params_json, '$.sourceId') = sources.id
      AND COALESCE(json_extract(j.params_json, '$.reextract'), 0) != 1)`,
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
            const { sourceId } = ctx.params as { sourceId: string };
            const count = await indexModelVectors(db, modelDir, ctx.signal, sourceId);
            await compareToPlans(db, modelDir, sourceId, ctx.signal);
            return { count };
          },
        },
      ],
    });
    // One step per language, so the job's progress moves as each file is verified and kept. Retry re-checks the files
    // already on disk and fetches only what is missing or altered.
    runner.register("ocr-data-download", {
      jobClass: "local",
      steps: OCR_LANGUAGES.map((lang) => ({
        name: lang,
        label: "sources.jobs.ocrData",
        async run(ctx: { signal: AbortSignal }) {
          if (!ocrConsent(db)) throw new Error("ocr-data-declined");
          await downloadOcrLanguage(tess, lang, ctx.signal);
          return { lang };
        },
      })),
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
            const count = await indexModelVectors(db, modelDir, ctx.signal);
            const sources = db.prepare("SELECT id FROM sources WHERE status != 'removed'").all() as Array<{ id: string }>;
            for (const source of sources) {
              ctx.signal.throwIfAborted();
              await compareToPlans(db, modelDir, source.id, ctx.signal);
            }
            return { count };
          },
        },
      ],
    });
  }
  const activeOcrDownload = () =>
    runner?.list().find((job) => job.kind === "ocr-data-download" && ["queued", "running"].includes(job.state))?.id;
  const requireOcrData = async () => {
    const { state } = await ocrDataStatus(tess);
    if (state !== "ready") throw new Error(`ocr-data-${state}`);
  };
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
        // Only a stored comparison is read: the list never embeds or recomputes anything.
        const off = source.planCount > 0
          ? (storedSyllabus(db, source.id) ?? []).reduce((sum, check) => sum + check.off, 0)
          : 0;
        return { ...source, bytes, ...(off > 0 ? { syllabusOff: off } : {}) };
      });
    },
    async importFile(input: { path: string }) {
      try {
        const ext = extname(input.path).toLowerCase();
        if (runner) {
          await assertLocalOcrReady(db, workspace, ext);
          return await enqueueSourceFile(db, workspace, runner, input.path);
        }
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
    async scanFolder(input: { path: string }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const files: string[] = [];
      const listing = listImportable(input.path);
      for (const file of listing.files) {
        try {
          files.push(authorizeFile(file));
        } catch {
          /* A file outside the grant is not offered. */
        }
      }
      // The worker streams each file through SHA-256, so core never holds the bytes.
      const hashes = files.length
        ? await work<Array<string | null>>(
            "extract-worker",
            { mode: "hash", paths: files, maxBytes: MAX_SOURCE_BYTES },
            signal,
          )
        : [];
      return {
        files: files.map((file, index) => ({
          path: file,
          name: basename(file),
          duplicate: hashes[index] ? isDuplicateBlob(db, hashes[index]!) : false,
        })),
        cappedFiles: listing.cappedFiles,
        cappedDepth: listing.cappedDepth,
        limit: MAX_FOLDER_FILES,
      };
    },
    async preview(input: { path: string }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      try {
        const ext = extname(input.path).toLowerCase();
        const maxBytes = maxSourceBytes(ext);
        if (statSync(input.path).size > maxBytes) throw new Error("source-too-big");
        // Hash and blur decode run in the worker. Core only looks the hash up.
        const { sha, variance } = await work<{ sha: string; variance: number | null }>(
          "extract-worker",
          { path: input.path, ext, mode: "quality", maxBytes },
          signal,
        );
        const flags = qualityFlags({
          duplicate: isDuplicateBlob(db, sha),
          variance,
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
    /** SRC-12: read the stored original again as a new version. A source plans use needs `confirmed`. */
    async reextract(input: { sourceId: string; confirmed: boolean }) {
      try {
        if (!runner) throw new Error("reextract-unavailable");
        const row = db
          .prepare(`SELECT mime FROM sources WHERE id = ? AND status != 'removed'`)
          .get(input.sourceId) as { mime: string | null } | undefined;
        const ext = row ? extForMime(row.mime) : undefined;
        if (ext) await assertLocalOcrReady(db, workspace, ext);
        return enqueueReextract(db, workspace, runner, input.sourceId, input.confirmed);
      } catch (err) {
        sourceError(err);
      }
    },
    /** SRC-08: sections of the source that sit off each plan's syllabus. Local vectors only, no engine request. */
    syllabus(input: { sourceId: string }, signal?: AbortSignal) {
      return syllabusFor(db, modelDir, input.sourceId, signal);
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
    async ocrImage(
      input: {
        sourceId: string;
        pngBase64: string;
        page: number;
        last: boolean;
      },
      signal?: AbortSignal,
    ) {
      try {
        let png: Buffer;
        try {
          signal?.throwIfAborted();
          // The text length is bounded before it is decoded, and the page must be a PNG, so nothing oversize or foreign
          // reaches a decode, the worker or a row.
          if (input.pngBase64.length > MAX_IMAGE_BASE64) throw new Error("source-too-big");
          png = Buffer.from(input.pngBase64, "base64");
          if (png.length > MAX_IMAGE_BYTES) throw new Error("source-too-big");
          if (sniffImage(png) !== "image/png") throw new Error("vision-image-unsupported");
        } catch (err) {
          // A refused page must not leave the scan queued. Only a queued row changes, so a scan that already finished stays.
          stopOcr(db, input.sourceId);
          throw err;
        }
        // The same worker and decode gate as chat and photo import, so a rotated or hostile page never decodes on core.
        const status = await ocrPngPage(
          db,
          input.sourceId,
          input.page,
          png,
          (bytes) =>
            work<string>("extract-worker", { path: "", ext: "", tess, mode: "ocr", bytes }, signal),
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
        if (signal?.aborted || isAbort(err)) throw err;
        sourceError(err);
      }
    },
    /** Disk truth for the OCR language data, plus the student's saved answer and the download job if one is active. Never downloads. */
    async ocrDataState() {
      const { state, totalBytes } = await ocrDataStatus(tess);
      const jobId = activeOcrDownload();
      return { consent: ocrConsent(db), state, totalBytes, languages: OCR_LANGUAGES, ...(jobId ? { jobId } : {}) };
    },
    /** Saves the answer. Agreeing starts, or re-attaches to, the one download job. Declining is only saved. */
    async ocrData(input: { consent: boolean }) {
      setOcrConsent(db, input.consent);
      if (!input.consent) {
        // Withdrawing stops a download in progress: the abort reaches the fetch and the check before the file is kept.
        const running = activeOcrDownload();
        if (running) runner?.cancel(running);
        return { state: "off" as const };
      }
      if ((await ocrDataStatus(tess)).state === "ready") return { state: "ready" as const };
      if (!runner) throw new IpcError("not-ready", "errors.notReady");
      return { state: "missing" as const, jobId: activeOcrDownload() ?? runner.start("ocr-data-download") };
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
      const book = smartbookMeta(db, input.sourceId);
      if (book) return book;
      // A photo has no smartbook metadata. It keeps which path read it.
      const row = db
        .prepare(
          `SELECT s.title, d.tree_json FROM sources s
           JOIN source_documents d ON d.source_id = s.id
           WHERE s.id = ? AND s.kind = 'image' ORDER BY d.version DESC LIMIT 1`,
        )
        .get(input.sourceId) as
        { title: string; tree_json: string } | undefined;
      const extractor = row
        ? (JSON.parse(row.tree_json) as { extractor?: Extractor }).extractor
        : undefined;
      return row && extractor
        ? {
            title: row.title,
            authors: [],
            version: null,
            specVersion: null,
            knownSpec: true,
            extractor,
          }
        : null;
    },
    async ocr(input: { sourceId: string }) {
      // Pages come from the stored file. A source without one has nothing to send, so it is refused before it is queued.
      const stored = db.prepare(`SELECT blob_sha FROM sources WHERE id = ?`).get(input.sourceId) as
        { blob_sha: string | null } | undefined;
      if (stored && !stored.blob_sha) sourceError(new Error("source-file-missing"));
      // The pages are rendered and sent one by one, so a missing language file is reported before any of that starts.
      try {
        await requireOcrData();
      } catch (err) {
        sourceError(err);
      }
      try {
        requestOcr(db, input.sourceId);
      } catch (err) {
        sourceError(err);
      }
      return { status: "ocr-queued" as const };
    },
    /**
     * The renderer stops a page-by-page scan that it cannot finish (a page failed to render, the student cancelled). The
     * scan returns to needs-ocr with its pages kept. Idempotent: a source that is not queued, or is gone, is left alone.
     */
    ocrStop(input: { sourceId: string }) {
      stopOcr(db, input.sourceId);
      return { ok: true as const };
    },
    /** The window that drove any scan is gone, and its core replies with it, so every queued scan is stopped. */
    ocrStopAll() {
      stopOcr(db);
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
