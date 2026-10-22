import { systemPrompt, promptProvenance } from "../engine/prompts";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { hasBlob, putBlob, readBlob } from "../blobs";
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
import { addSmartbookVersion, storeSmartbook, type ParsedSmartbook } from "./smartbook";
import { imageMime, isHeicBytes, isHeicExt, MAX_HEIC_BYTES } from "./heic";
import { runSourceWorker } from "./worker-client";
import { loadVisionImage, type VisionImage } from "./vision-image";
import { isImageExt, maxSourceBytes } from "../../shared/source-types";
import { PDF_PASSWORD_ERRORS } from "../../shared/source-errors";
import { generate, type GenerateInput } from "../engine/generate";
import { engineSeesImages } from "../engine/capabilities";
import { selectionFor, type StoredSelection } from "../engine/selection";
import { isAbort, type JobView } from "../../shared/ipc";
import { fetchSnapshot } from "./link";
import { IMPORT_EXTENSIONS } from "./folder";
import { extForMime, plansUsing } from "./manage";


type ImportParams = {
  sourceId: string;
  sha: string;
  ext: string;
  title: string;
  extractedSha?: string;
  url?: string;
  fetched?: boolean;
  replace?: boolean;
  /** For a replacement, the status the source had before it. A replacement that stops goes back to it. */
  previousStatus?: string;
  /**
   * The status the source has once this version is read, saved with its passages. From then on the text is in use,
   * so a job that stops while indexing leaves the source in this status instead of hiding it.
   */
  doneStatus?: "ready" | "needs-ocr" | "failed";
  /**
   * The status the source had right after the passages were stored. This job changes the status later only while it
   * is still this, `indexing` or `doneStatus`, so a scan read by OCR in the meantime keeps what OCR gave it.
   */
  passagesStatus?: string;
  /** The step `runner.resumeLocal` resumed this job at after a restart, if it did. */
  autoResumedAt?: string;
  /** Read the stored original again as a new version. The file, name and type stay, and old passages are kept. */
  reextract?: boolean;
  version: number;
  /** The vision engine chosen when the image was queued or last retried. */
  vision?: StoredSelection;
  /** A free PoliTost book: the catalog book and version these bytes are. An update records it once it is published. */
  catalog?: { id: string; version: string };
  /**
   * A link fetched again (Check for a new version). `sha` and `ext` are the new snapshot and `url` the address it came
   * from. The source row takes them, with this time, only when the new version is published.
   */
  refresh?: { fetchedAt: number };
};
export type Extraction = {
  book?: ParsedSmartbook;
  document?: ExtractedDocument;
};

/** The source a job works on, as the library names it now (after a rename, or a link's page title), or as queued. */
export function sourceTitle(db: Database.Database, params: unknown): string | null {
  const { sourceId, title } = params as { sourceId?: string; title?: string };
  const row = sourceId
    ? (db.prepare(`SELECT title FROM sources WHERE id = ?`).get(sourceId) as { title: string } | undefined)
    : undefined;
  return row?.title ?? title ?? null;
}

/** A photo goes to the vision feature engine when that model sees images. Otherwise local OCR reads it. */
export function visionSelection(
  db: Database.Database,
  ext: string,
): StoredSelection | undefined {
  if (!isImageExt(ext)) return undefined;
  try {
    const selection = selectionFor(db, "vision");
    return engineSeesImages(selection) ? selection : undefined;
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
  if (!isImageExt(ext) || visionSelection(db, ext)) return;
  if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: OCR readiness start");
  const { state } = await ocrDataStatus(join(workspace, "runtimes", "tesseract"));
  if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: OCR readiness", state);
  if (state !== "ready") throw new Error(`ocr-data-${state}`);
}

const VISION_MAX_CHARS = 60_000;

/**
 * Passwords for locked PDFs, held in this process only, by the import they open (`sourceId:version`). The job's
 * stored input never has one. The extract step takes it out as it reads, so a retry or a resume after a restart
 * finds none and the import asks again.
 */
const pdfPasswords = new Map<string, string>();
const passwordKey = (params: { sourceId: string; version: number }) => `${params.sourceId}:${params.version}`;

/**
 * Runs again a source import that stopped on a locked PDF, with `password` for that one read. Only a failed import
 * whose error asks for a password is accepted (`pdf-password-unavailable` otherwise), so the password never reaches any
 * other job. It is not stored: not in the job, the database or a log.
 */
export function unlockPdfImport(
  db: Database.Database,
  runner: Runner,
  jobId: string,
  password: string,
): { jobId: string } {
  const job = db
    .prepare(
      `SELECT params_json FROM jobs WHERE id = ? AND kind = 'source-import' AND state = 'failed'
       AND error IN (${PDF_PASSWORD_ERRORS.map(() => "?").join(", ")})`,
    )
    .get(jobId, ...PDF_PASSWORD_ERRORS) as { params_json: string } | undefined;
  if (!job || !password) throw new Error("pdf-password-unavailable");
  const params = JSON.parse(job.params_json) as ImportParams;
  pdfPasswords.set(passwordKey(params), password);
  runner.retry(jobId);
  return { jobId };
}

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
    input: { path: string; ext: string; tess: string; password?: string },
    signal: AbortSignal,
  ) => runSourceWorker<Extraction>("extract-worker", input, signal),
  deps: Deps = {},
): void {
  const modelDir = join(workspace, "models", "e5");
  const base: JobSpec = {
    jobClass: "local",
    title: (params) => sourceTitle(db, params),
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
          // A password is used for one read, whatever its outcome. A wrong one asks again.
          const password = pdfPasswords.get(passwordKey(input));
          pdfPasswords.delete(passwordKey(input));
          const value = await extract(
            {
              path: readBlob(workspace, input.sha).file,
              ext: input.ext,
              tess: join(workspace, "runtimes", "tesseract"),
              ...(password ? { password } : {}),
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
          // The original was stored under `input.sha` when the job was queued, so it is not read back into core.
          if (!value.book && !input.reextract && !hasBlob(workspace, input.sha))
            throw new Error("source-file-missing");
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
              if (value.book && input.replace)
                addSmartbookVersion(db, input.sourceId, value.book, {
                  sha: input.sha,
                  catalog: input.catalog,
                });
              else if (value.book)
                storeSmartbook(db, value.book, Date.now(), input.sourceId);
              else if (value.document && input.reextract)
                addExtractionVersion(
                  db,
                  input.sourceId,
                  value.document,
                  input.refresh && input.url
                    ? {
                        sha: input.sha,
                        ext: input.ext,
                        url: input.url,
                        fetchedAt: input.refresh.fetchedAt,
                      }
                    : undefined,
                );
              else if (value.document && input.replace)
                addDocumentVersion(db, workspace, input.sourceId, {
                  title: input.title,
                  mime: mimeFor(input.ext),
                  ext: input.ext,
                  sha: input.sha,
                  extracted: value.document,
                });
              else if (value.document)
                storeExtracted(db, workspace, {
                  sourceId: input.sourceId,
                  title: input.title,
                  kind: isImageExt(input.ext)
                    ? "image"
                    : kindFor(input.ext),
                  mime: isImageExt(input.ext)
                    ? imageMime(input.ext)
                    : mimeFor(input.ext),
                  ext: input.ext,
                  sha: input.sha,
                  extracted: value.document,
                });
              else throw new Error("extraction-failed");
            }
            const stored = db.prepare(`SELECT status FROM sources WHERE id = ?`).get(input.sourceId) as { status: string };
            ctx.setParams({ ...input, doneStatus: doneStatus(input, value), passagesStatus: stored.status });
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
            // Resumed after a restart, the source's text was already in use and stays so while the vectors are redone.
            if (!input.reextract && input.autoResumedAt !== "vectors") setStatusIfHeld(db, input, "indexing");
            await indexModelVectors(db, modelDir, ctx.signal, input.sourceId);
            await compareToPlans(db, modelDir, input.sourceId, ctx.signal);
          }
          ctx.signal.throwIfAborted();
          // A job whose passages were stored before 0.3.2 has no saved status, so it is worked out here.
          const status =
            input.doneStatus ??
            doneStatus(
              input,
              JSON.parse(await readFile(readBlob(workspace, input.extractedSha!).file, "utf8")) as Extraction,
            );
          setStatusIfHeld(db, input, status);
          return { sourceId: input.sourceId };
        },
      },
    ],
  };
  /** A photo with no text read fails; a scan waits for OCR; anything else is ready. Its passages are already stored. */
  function doneStatus(input: ImportParams, extracted: Extraction): NonNullable<ImportParams["doneStatus"]> {
    const emptyImage =
      isImageExt(input.ext) &&
      !db
        .prepare("SELECT 1 FROM passages WHERE source_id = ? AND version = ? LIMIT 1")
        .get(input.sourceId, input.version);
    return emptyImage ? "failed" : extracted.document?.scanned ? "needs-ocr" : "ready";
  }
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

const IMPORT_KINDS = ["source-import", "source-import-vision"];

/**
 * Sets the status of a source whose passages this job stored, but only while the source still has a status the job
 * left there. OCR started on the scan meanwhile moves it on (`ocr-queued`, then `ready` or `failed`), and that wins
 * over a stopped import that is retried or resumed later. A job from before 0.3.2 has no record and always sets it.
 */
function setStatusIfHeld(db: Database.Database, params: Partial<ImportParams>, status: string, touch = false): void {
  const now = touch ? Date.now() : null;
  if (!params.passagesStatus) {
    db.prepare(
      `UPDATE sources SET status = ?, updated_at = COALESCE(?, updated_at) WHERE id = ? AND status != 'removed'`,
    ).run(status, now, params.sourceId);
    return;
  }
  db.prepare(
    `UPDATE sources SET status = ?, updated_at = COALESCE(?, updated_at) WHERE id = ? AND status IN (?, 'indexing', ?)`,
  ).run(status, now, params.sourceId, params.passagesStatus, params.doneStatus ?? params.passagesStatus);
}

/**
 * The status a source shows once its import job stopped, or null to leave it as it is. A source read again keeps its
 * earlier reading, so its status never changed. A replacement keeps using the version it was replacing, so it goes
 * back to the status it had before (a replacement queued before 0.2.3 has none saved; its source had text, so `ready`).
 */
function stoppedStatus(params: Partial<ImportParams>, state: string): string | null {
  if (params.reextract) return null;
  if (params.replace) return params.previousStatus ?? "ready";
  return state;
}

/**
 * A source whose import job stopped (failed, cancelled, interrupted) shows that state instead of "extracting". Photos
 * read by the vision engine (`source-import-vision`) count like any import. A source read again or replaced keeps
 * its earlier version in use when the job stops, so it keeps the status that version had. A job that stopped after
 * storing its passages leaves the source as those passages made it (`doneStatus`): its text is in use, only vectors
 * are missing, and Retry or Resume adds them.
 */
export function markStoppedImport(db: Database.Database, job: JobView): void {
  if (
    !IMPORT_KINDS.includes(job.kind) ||
    !["failed", "cancelled", "interrupted"].includes(job.state)
  )
    return;
  const row = db
    .prepare(`SELECT params_json FROM jobs WHERE id = ?`)
    .get(job.id) as { params_json: string } | undefined;
  if (!row) return;
  const params = JSON.parse(row.params_json) as Partial<ImportParams>;
  if (params.doneStatus && params.sourceId) return setStatusIfHeld(db, params, params.doneStatus, true);
  const status = stoppedStatus(params, job.state);
  if (!status || !params.sourceId) return;
  db.prepare(
    `UPDATE sources SET status = ?, updated_at = ? WHERE id = ? AND status != 'removed'`,
  ).run(status, Date.now(), params.sourceId);
}

/**
 * At startup the runner has turned running jobs into interrupted ones without telling anyone, so their sources still say
 * they are being read. Each gets the status `markStoppedImport` would give it. A source that reached ready stays ready.
 * A job that had stored its passages leaves its source in their status (`doneStatus`) whether it waits for Resume or
 * `runner.resumeLocal` queued it again, so a source cut off while indexing stays usable. A queued job that had not
 * stored them keeps the working status its source has.
 */
export function markInterruptedImports(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT state, params_json FROM jobs WHERE kind IN ('source-import', 'source-import-vision') AND state IN ('interrupted', 'queued')`,
    )
    .all() as Array<{ state: string; params_json: string }>;
  const update = db.prepare(
    `UPDATE sources SET status = ? WHERE id = ? AND status NOT IN ('removed', 'ready')`,
  );
  for (const row of rows) {
    const params = JSON.parse(row.params_json) as Partial<ImportParams>;
    if (params.doneStatus && params.sourceId) setStatusIfHeld(db, params, params.doneStatus);
    else if (row.state === "interrupted") {
      const status = stoppedStatus(params, "interrupted");
      if (status && params.sourceId) update.run(status, params.sourceId);
    }
  }
}

/**
 * What keeps Replace and Re-extract from starting. A job that is queued or running does. So does an import or
 * extraction job that stopped (failed, cancelled, interrupted) and was neither retried nor dismissed: it holds a
 * half-made version, and the student chooses whether to resume or drop it. A stopped `source-index` job does not. It
 * only embeds the latest version's passages, so it holds nothing back, and the plan-edit checks queue it on their own,
 * so the student never sees it to dismiss it.
 */
export function hasUnfinishedJob(db: Database.Database, sourceId: string): boolean {
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

/**
 * Check for a new version of a source imported from a link: the address is fetched again, and a page that changed is
 * read as the next version of the same source through the import job, as a re-extract is. Items that cite the old
 * text keep it, marked stale, and its citations open the copy saved then, as after a book update. A source that plans
 * use asks first (`started: false`, `inUse`), and nothing is fetched until it is confirmed. A page whose bytes have not
 * changed starts nothing (`unchanged`). Errors: `source-missing`, `refresh-unavailable` (no link), `source-busy`, and
 * the fetch's `link-*`.
 */
export async function enqueueRefresh(
  db: Database.Database,
  workspace: string,
  runner: Runner,
  sourceId: string,
  confirmed: boolean,
  signal?: AbortSignal,
  fetchPage: (url: string, signal?: AbortSignal) => ReturnType<typeof fetchSnapshot> = (url, abort) =>
    fetchSnapshot(url, undefined, undefined, abort),
): Promise<{ started: boolean; inUse: number; unchanged?: true; jobId?: string }> {
  const source = db
    .prepare(
      `SELECT title, kind, blob_sha AS sha, origin_url AS url FROM sources WHERE id = ? AND status != 'removed'`,
    )
    .get(sourceId) as { title: string; kind: string; sha: string | null; url: string | null } | undefined;
  if (!source) throw new Error("source-missing");
  // A saved page is a `link` or a `pdf`. A source replaced by a file before the address was cleared on replace is neither.
  if (!source.url || (source.kind !== "link" && source.kind !== "pdf")) throw new Error("refresh-unavailable");
  if (hasUnfinishedJob(db, sourceId)) throw new Error("source-busy");
  const inUse = plansUsing(db, sourceId);
  if (inUse > 0 && !confirmed) return { started: false, inUse };
  const page = await fetchPage(source.url, signal);
  signal?.throwIfAborted();
  const ext = page.pdf ? ".pdf" : ".md";
  const sha = putBlob(
    workspace,
    page.pdf ?? new TextEncoder().encode(page.markdown),
    mimeFor(ext),
    ext.slice(1),
  );
  if (sha === source.sha) return { started: false, inUse, unchanged: true };
  // The fetch took a while. Another job may have started on the source meanwhile.
  if (hasUnfinishedJob(db, sourceId)) throw new Error("source-busy");
  const version = (
    db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`,
      )
      .get(sourceId) as { n: number }
  ).n;
  const jobId = runner.start("source-import", {
    sourceId,
    sha,
    ext,
    title: source.title,
    url: page.finalUrl,
    fetched: true,
    version,
    reextract: true,
    refresh: { fetchedAt: Date.now() },
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
    // The name without its extension, whatever its case: "Notes.PDF" becomes "Notes".
    basename(path, extname(path)),
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
  /** The free book these bytes are, from the catalog. A new source records it; an update records it once published. */
  catalog?: { id: string; version: string },
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
      : isImageExt(ext)
        ? "image"
        : kindFor(ext);
  const mime =
    kind === "smartbook"
      ? "application/vnd.politost.ptsb"
      : kind === "image"
        ? imageMime(ext)
        : mimeFor(ext);
  if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: import blob start");
  const sha = putBlob(workspace, bytes, mime, ext.slice(1));
  if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: import transaction start");
  const jobId = db.transaction(() => {
    let previousStatus: string | undefined;
    if (existingId) {
      if (
        !db
          .prepare(`SELECT 1 FROM sources WHERE id = ? AND status != 'removed'`)
          .get(existingId)
      )
        throw new Error("source-missing");
      if (hasUnfinishedJob(db, existingId)) throw new Error("source-busy");
      previousStatus = (
        db.prepare(`SELECT status FROM sources WHERE id = ?`).get(existingId) as { status: string }
      ).status;
      db.prepare(
        `UPDATE sources SET status = 'queued', updated_at = ? WHERE id = ?`,
      ).run(Date.now(), existingId);
    } else {
      db.prepare(
        `INSERT INTO sources (id, kind, title, blob_sha, mime, status, catalog_id, catalog_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      ).run(
        sourceId,
        kind,
        title,
        sha,
        mime,
        catalog?.id ?? null,
        catalog?.version ?? null,
        Date.now(),
        Date.now(),
      );
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
      ...(previousStatus ? { previousStatus } : {}),
      ...(vision ? { vision } : {}),
      ...(catalog ? { catalog } : {}),
    } satisfies ImportParams);
  })();
  if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: import transaction committed");
  return { sourceId, jobId, title, chapters: 0, passages: 0, exercises: 0 };
}
