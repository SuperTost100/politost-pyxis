import { systemPrompt, promptProvenance } from "../engine/prompts";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { putBlob, readBlob } from "../blobs";
import type { JobSpec, Runner } from "../jobs/runner";
import {
  addDocumentVersion,
  addExtractionVersion,
  kindFor,
  mimeFor,
  storeExtracted,
  type ExtractedDocument,
} from "./documents";
import { embeddingConsent, embeddingReady, indexModelVectors } from "./embed";
import { ocrDataStatus } from "./ocr-data";
import { compareToPlans } from "./syllabus";
import { storeSmartbook, type ParsedSmartbook } from "./smartbook";
import { imageMime, isHeicBytes, isHeicExt, MAX_HEIC_BYTES } from "./heic";
import { runSourceWorker } from "./worker-client";
import { loadVisionImage, type VisionImage } from "./vision-image";
import { maxSourceBytes } from "../../shared/source-types";
import { generate, type GenerateInput } from "../engine/generate";
import { capabilityWarning } from "../engine/capabilities";
import { selectionFor, type StoredSelection } from "../engine/selection";
import { isAbort, type JobView } from "../../shared/ipc";
import { fetchSnapshot } from "./link";
import { IMPORT_EXTENSIONS } from "./folder";
import { extForMime, plansUsing } from "./manage";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"];

type ImportParams = {
  sourceId: string;
  sha: string;
  ext: string;
  title: string;
  extractedSha?: string;
  url?: string;
  fetched?: boolean;
  replace?: boolean;
  /** Read the stored original again as a new version. The file, name and type stay, and old passages are kept. */
  reextract?: boolean;
  version: number;
  /** The vision engine chosen when the image was queued or last retried. */
  vision?: StoredSelection;
};
export type Extraction = {
  book?: ParsedSmartbook;
  document?: ExtractedDocument;
};

/** A photo goes to the vision feature engine when that model sees images. Otherwise local OCR reads it. */
export function visionSelection(
  db: Database.Database,
  ext: string,
): StoredSelection | undefined {
  if (!IMAGE_EXTS.includes(ext)) return undefined;
  try {
    const selection = selectionFor(db, "vision");
    return capabilityWarning(selection.model, "vision") == null
      ? selection
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A photo that no vision engine will read goes to local OCR, which needs its language data. Refuse before any source row
 * or job exists, so the student is told to download it (`ocr-data-missing`, or `ocr-data-integrity` for an altered file).
 * A photo that a vision engine reads and then fails on can still fall back later, and that job fails with the same codes.
 */
export async function assertLocalOcrReady(db: Database.Database, workspace: string, ext: string): Promise<void> {
  if (!IMAGE_EXTS.includes(ext) || visionSelection(db, ext)) return;
  const { state } = await ocrDataStatus(join(workspace, "runtimes", "tesseract"));
  if (state !== "ready") throw new Error(`ocr-data-${state}`);
}

const VISION_MAX_CHARS = 60_000;

type Deps = {
  run?: GenerateInput["run"];
  /** The image as the vision model gets it, fitted to provider limits. */
  vision?: (
    path: string,
    ext: string,
    signal: AbortSignal,
  ) => Promise<VisionImage>;
};

export function registerSourceJobs(
  db: Database.Database,
  workspace: string,
  runner: Runner,
  extract = (
    input: { path: string; ext: string; tess: string },
    signal: AbortSignal,
  ) => runSourceWorker<Extraction>("extract-worker", input, signal),
  deps: Deps = {},
): void {
  const modelDir = join(workspace, "models", "e5");
  const base: JobSpec = {
    jobClass: "local",
    steps: [
      {
        name: "extract",
        label: "sources.jobs.extract",
        async run(ctx) {
          let input = ctx.params as ImportParams;
          // A source read again keeps its status: its earlier reading stays usable until the new one is published.
          if (!input.reextract)
            db.prepare(
              `UPDATE sources SET status = 'extracting' WHERE id = ? AND status != 'removed'`,
            ).run(input.sourceId);
          if (input.url && !input.fetched) {
            const page = await fetchSnapshot(
              input.url,
              undefined,
              undefined,
              ctx.signal,
            );
            ctx.signal.throwIfAborted();
            const ext = page.pdf ? ".pdf" : ".md";
            const sha = putBlob(
              workspace,
              page.pdf ?? new TextEncoder().encode(page.markdown),
              mimeFor(ext),
              ext.slice(1),
            );
            input = { ...input, sha, ext, title: page.title, fetched: true };
            db.transaction(() => {
              db.prepare(
                `UPDATE sources SET blob_sha = ?, mime = ?, kind = ?, title = ?, origin_url = ?, fetched_at = ? WHERE id = ? AND status != 'removed'`,
              ).run(
                sha,
                mimeFor(ext),
                page.pdf ? "pdf" : "link",
                page.title,
                page.finalUrl,
                Date.now(),
                input.sourceId,
              );
              ctx.setParams(input);
            })();
          }
          const value = await extract(
            {
              path: readBlob(workspace, input.sha).file,
              ext: input.ext,
              tess: join(workspace, "runtimes", "tesseract"),
            },
            ctx.signal,
          );
          ctx.signal.throwIfAborted();
          const extractedSha = putBlob(
            workspace,
            Buffer.from(JSON.stringify(value)),
            "application/json",
            "json",
          );
          ctx.setParams({ ...input, extractedSha });
          return { extractedSha };
        },
      },
      {
        name: "passages",
        label: "sources.jobs.passages",
        async run(ctx) {
          const input = ctx.params as ImportParams;
          const value = JSON.parse(
            await readFile(
              readBlob(workspace, input.extractedSha!).file,
              "utf8",
            ),
          ) as Extraction;
          ctx.signal.throwIfAborted();
          // Only a new file is stored from these bytes. A smartbook, or a source read again, never reads the original into core.
          const bytes =
            input.reextract || value.book
              ? new Uint8Array()
              : new Uint8Array(await readFile(readBlob(workspace, input.sha).file));
          ctx.signal.throwIfAborted();
          db.transaction(() => {
            const source = db
              .prepare(`SELECT status FROM sources WHERE id = ?`)
              .get(input.sourceId) as { status: string } | undefined;
            if (!source || source.status === "removed")
              throw new Error("source-missing");
            // The source and checkpoint commit together. Restart cannot duplicate passages.
            if (
              !db
                .prepare(
                  `SELECT 1 FROM source_documents WHERE source_id = ? AND version = ?`,
                )
                .get(input.sourceId, input.version)
            ) {
              if (value.book)
                storeSmartbook(db, value.book, Date.now(), input.sourceId);
              else if (value.document && input.reextract)
                addExtractionVersion(db, input.sourceId, value.document);
              else if (value.document && input.replace)
                addDocumentVersion(db, workspace, input.sourceId, {
                  title: input.title,
                  mime: mimeFor(input.ext),
                  ext: input.ext,
                  bytes,
                  extracted: value.document,
                });
              else if (value.document)
                storeExtracted(db, workspace, {
                  sourceId: input.sourceId,
                  title: input.title,
                  kind: IMAGE_EXTS.includes(input.ext)
                    ? "image"
                    : kindFor(input.ext),
                  mime: IMAGE_EXTS.includes(input.ext)
                    ? imageMime(input.ext)
                    : mimeFor(input.ext),
                  ext: input.ext,
                  bytes,
                  extracted: value.document,
                });
              else throw new Error("extraction-failed");
            }
            ctx.setParams(input);
          })();
          return { sourceId: input.sourceId };
        },
      },
      {
        name: "vectors",
        label: "sources.jobs.vectors",
        async run(ctx) {
          const input = ctx.params as ImportParams;
          if (embeddingConsent(db) && embeddingReady(modelDir)) {
            if (!input.reextract)
              db.prepare(
                `UPDATE sources SET status = 'indexing' WHERE id = ? AND status != 'removed'`,
              ).run(input.sourceId);
            await indexModelVectors(db, modelDir, ctx.signal, input.sourceId);
            await compareToPlans(db, modelDir, input.sourceId, ctx.signal);
          }
          ctx.signal.throwIfAborted();
          const extracted = JSON.parse(
            await readFile(
              readBlob(workspace, input.extractedSha!).file,
              "utf8",
            ),
          ) as Extraction;
          const emptyImage =
            IMAGE_EXTS.includes(input.ext) &&
            !db
              .prepare(
                "SELECT 1 FROM passages WHERE source_id = ? AND version = ? LIMIT 1",
              )
              .get(input.sourceId, input.version);
          db.prepare(
            `UPDATE sources SET status = ? WHERE id = ? AND status != 'removed'`,
          ).run(
            emptyImage
              ? "failed"
              : extracted.document?.scanned
                ? "needs-ocr"
                : "ready",
            input.sourceId,
          );
          return { sourceId: input.sourceId };
        },
      },
    ],
  };
  runner.register("source-import", base);
  runner.register("source-import-vision", {
    ...base,
    // A retry picks the vision engine again. If it no longer sees images, the photo reads locally.
    retryParams: (raw) => {
      const input = raw as ImportParams;
      return { ...input, vision: visionSelection(db, input.ext) };
    },
    jobClass: "model-cli",
    steps: [
      {
        name: "extract",
        label: "sources.jobs.extract",
        async run(ctx) {
          const input = ctx.params as ImportParams;
          if (!input.reextract)
            db.prepare(
              `UPDATE sources SET status = 'extracting' WHERE id = ? AND status != 'removed'`,
            ).run(input.sourceId);
          const path = readBlob(workspace, input.sha).file;
          const local = async (
            after?: "vision-failed" | "vision-too-large",
          ) => {
            const value = await extract(
              {
                path,
                ext: input.ext,
                tess: join(workspace, "runtimes", "tesseract"),
              },
              ctx.signal,
            );
            return value.document
              ? {
                  document: {
                    ...value.document,
                    extractor: {
                      path: "ocr" as const,
                      ...(after ? { after } : {}),
                    },
                  },
                }
              : value;
          };
          let value!: Extraction;
          if (!input.vision) value = await local();
          else {
            // The stored original stays as it is. Only the copy sent to the model is resized.
            let image: VisionImage | undefined;
            try {
              image = await (deps.vision ?? loadVisionImage)(
                path,
                input.ext,
                ctx.signal,
              );
            } catch (error) {
              if (ctx.signal.aborted || isAbort(error)) throw error;
              value = await local(
                error instanceof Error &&
                  error.message === "vision-image-too-large"
                  ? "vision-too-large"
                  : "vision-failed",
              );
            }
            ctx.signal.throwIfAborted();
            if (image) {
              try {
                const result = await generate({
                  prompt: "Transcribe this image.",
                  system: systemPrompt("source.transcribe"),
                  selection: input.vision,
                  attachments: [
                    {
                      type: "image",
                      mediaType: image.mediaType,
                      data: Buffer.from(image.bytes).toString("base64"),
                    },
                  ],
                  signal: ctx.signal,
                  run: deps.run,
                });
                const text = result.text.trim().slice(0, VISION_MAX_CHARS);
                value = {
                  document: {
                    pages: [{ text, locator: { page: 1 }, section: "text" }],
                    scanned: false,
                    extractor: {
                      path: "vision",
                      prompt: promptProvenance("source.transcribe"),
                      provider: result.provider,
                      model: result.model,
                      sent: {
                        mediaType: image.mediaType,
                        bytes: image.bytes.length,
                        ...(image.width ? { width: image.width } : {}),
                        ...(image.height ? { height: image.height } : {}),
                        ...(image.resizedFrom
                          ? { resizedFrom: image.resizedFrom }
                          : {}),
                        ...(image.orientation
                          ? { orientation: image.orientation }
                          : {}),
                      },
                    },
                  },
                };
              } catch (error) {
                // Cancel, and a declined or timed-out consent, stop the import. Any other engine error reads the photo locally and says so.
                if (
                  ctx.signal.aborted ||
                  isAbort(error) ||
                  (error instanceof Error &&
                    error.message.startsWith("engine-disclosure"))
                )
                  throw error;
                value = await local("vision-failed");
              }
            }
          }
          ctx.signal.throwIfAborted();
          const extractedSha = putBlob(
            workspace,
            Buffer.from(JSON.stringify(value)),
            "application/json",
            "json",
          );
          ctx.setParams({ ...input, extractedSha });
          return { extractedSha };
        },
      },
      ...base.steps
        .slice(1)
        .map((step) => ({ ...step, jobClass: "local" as const })),
    ],
  });
}

/**
 * A source whose import job stopped (failed, cancelled, interrupted) shows that state instead of "extracting". Photos
 * read by the vision engine (`source-import-vision`) count like any import. A source read again keeps its earlier
 * reading when the job stops, so its status stays as it was.
 */
export function markStoppedImport(db: Database.Database, job: JobView): void {
  if (
    (job.kind !== "source-import" && job.kind !== "source-import-vision") ||
    !["failed", "cancelled", "interrupted"].includes(job.state)
  )
    return;
  db.prepare(
    `UPDATE sources SET status = ?, updated_at = ?
    WHERE id = (SELECT json_extract(params_json, '$.sourceId') FROM jobs WHERE id = ?)
      AND status != 'removed'
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE id = ? AND json_extract(params_json, '$.reextract') = 1)`,
  ).run(job.state, Date.now(), job.id, job.id);
}

/**
 * What keeps Replace and Re-extract from starting. A job that is queued or running does. So does an import or
 * extraction job that stopped (failed, cancelled, interrupted) and was neither retried nor dismissed: it holds a
 * half-made version, and the student chooses whether to resume or drop it. A stopped `source-index` job does not. It
 * only embeds the latest version's passages, so it holds nothing back, and the plan-edit checks queue it on their own,
 * so the student never sees it to dismiss it.
 */
function hasUnfinishedJob(db: Database.Database, sourceId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM jobs WHERE json_extract(params_json, '$.sourceId') = ?
        AND (state IN ('running', 'queued')
          OR (state IN ('failed', 'cancelled', 'interrupted') AND kind IN ('source-import', 'source-import-vision')))`,
      )
      .get(sourceId) != null
  );
}

/**
 * SRC-12 re-extract: read the stored original again through the durable import job, as a new extraction version of
 * the same source. Plans keep using the source, and items that cite the old text keep it, marked stale, until they
 * are regenerated, so a source that plans use asks for confirmation first (`started: false`, `inUse` plans).
 * A photo is read again by the vision engine when one is chosen now, otherwise by local OCR.
 * Errors: `source-missing`, `reextract-unavailable` (smartbook, or no stored original), `source-busy`.
 */
export function enqueueReextract(
  db: Database.Database,
  workspace: string,
  runner: Runner,
  sourceId: string,
  confirmed: boolean,
): { started: boolean; inUse: number; jobId?: string } {
  const source = db
    .prepare(
      `SELECT title, kind, blob_sha AS sha, mime FROM sources WHERE id = ? AND status != 'removed'`,
    )
    .get(sourceId) as
    | { title: string; kind: string; sha: string | null; mime: string | null }
    | undefined;
  if (!source) throw new Error("source-missing");
  const ext = extForMime(source.mime);
  if (!source.sha || source.kind === "smartbook" || !ext)
    throw new Error("reextract-unavailable");
  try {
    readBlob(workspace, source.sha);
  } catch {
    throw new Error("reextract-unavailable");
  }
  if (hasUnfinishedJob(db, sourceId)) throw new Error("source-busy");
  const inUse = plansUsing(db, sourceId);
  if (inUse > 0 && !confirmed) return { started: false, inUse };
  const version = (
    db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`,
      )
      .get(sourceId) as { n: number }
  ).n;
  const vision = visionSelection(db, ext);
  const jobId = runner.start(vision ? "source-import-vision" : "source-import", {
    sourceId,
    sha: source.sha,
    ext,
    title: source.title,
    version,
    reextract: true,
    ...(vision ? { vision } : {}),
  } satisfies ImportParams);
  return { started: true, inUse, jobId };
}

export async function enqueueSourceFile(
  db: Database.Database,
  workspace: string,
  runner: Runner,
  path: string,
  existingId?: string,
) {
  const ext = extname(path).toLowerCase();
  // The size is read before the file, so a huge one never gets a buffer.
  const size = (await stat(path)).size;
  if (size > maxSourceBytes(ext)) throw new Error("source-too-big");
  if (isHeicExt(ext) && size > MAX_HEIC_BYTES) throw new Error("heic-too-large");
  const bytes = new Uint8Array(await readFile(path));
  if (existingId && ![".pdf", ".docx", ".pptx", ".txt", ".md"].includes(ext))
    throw new Error("unsupported-file");
  return enqueueSourceData(
    db,
    workspace,
    runner,
    bytes,
    ext,
    basename(path, ext),
    undefined,
    existingId,
  );
}

export function enqueueSourceData(
  db: Database.Database,
  workspace: string,
  runner: Runner,
  bytes: Uint8Array,
  ext: string,
  title: string,
  url?: string,
  existingId?: string,
) {
  if (!IMPORT_EXTENSIONS.has(ext)) {
    throw new Error("unsupported-file");
  }
  // Reject before the blob or source row exists. The original bytes are stored untouched.
  if (isHeicExt(ext) && !isHeicBytes(bytes)) throw new Error("heic-invalid");
  if (isHeicExt(ext) && bytes.length > MAX_HEIC_BYTES)
    throw new Error("heic-too-large");
  const sourceId = existingId ?? uuidv7();
  const kind = url
    ? "link"
    : ext === ".ptsb"
      ? "smartbook"
      : IMAGE_EXTS.includes(ext)
        ? "image"
        : kindFor(ext);
  const mime =
    kind === "smartbook"
      ? "application/vnd.politost.ptsb"
      : kind === "image"
        ? imageMime(ext)
        : mimeFor(ext);
  const sha = putBlob(workspace, bytes, mime, ext.slice(1));
  const jobId = db.transaction(() => {
    if (existingId) {
      if (
        !db
          .prepare(`SELECT 1 FROM sources WHERE id = ? AND status != 'removed'`)
          .get(existingId)
      )
        throw new Error("source-missing");
      if (hasUnfinishedJob(db, existingId)) throw new Error("source-busy");
      db.prepare(
        `UPDATE sources SET status = 'queued', updated_at = ? WHERE id = ?`,
      ).run(Date.now(), existingId);
    } else {
      db.prepare(
        `INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(sourceId, kind, title, sha, mime, Date.now(), Date.now());
    }
    const version = (
      db
        .prepare(
          `SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`,
        )
        .get(sourceId) as { n: number }
    ).n;
    const vision = existingId ? undefined : visionSelection(db, ext);
    return runner.start(vision ? "source-import-vision" : "source-import", {
      sourceId,
      sha,
      ext,
      title,
      url,
      version,
      replace: Boolean(existingId),
      ...(vision ? { vision } : {}),
    } satisfies ImportParams);
  })();
  return { sourceId, jobId, title, chapters: 0, passages: 0, exercises: 0 };
}
