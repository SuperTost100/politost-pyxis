import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type Database from "better-sqlite3";
import { hasBlob, putBlob, readBlob, removeBlob } from "../blobs";
import { capabilityWarning } from "../engine/capabilities";
import { kindFor, mimeFor as documentMime, storeExtracted, type ExtractedDocument } from "../sources/documents";
import { readBoundedSync } from "../sources/bounded-read";
import { sha256 } from "../sources/quality";
import { ocrBytes, runSourceWorker } from "../sources/worker-client";
import { isHeicExt, imageMime } from "../sources/heic";
import {
  loadVisionImage,
  sniffImage,
  type VisionImage,
  type VisionMime,
} from "../sources/vision-image";
import { IpcError, isAbort } from "../../shared/ipc";

const images = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"]);
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
/** One attached document may take this long to read. Past it the read is stopped and the file refused. */
export const EXTRACT_TIMEOUT_MS = 120_000;

/**
 * Reads a chat document with the same extractors as a library import, in the extract worker behind the decode gate, so
 * a 15 MB PDF or a hostile .docx/.pptx cannot hold up core. The worker gets the bytes core already read within the cap,
 * and cancelling the turn, or the time limit, terminates it.
 */
export async function extractInWorker(
  path: string,
  ext: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<ExtractedDocument> {
  const limit = AbortSignal.timeout(timeoutMs);
  try {
    const { document } = await runSourceWorker<{ document: ExtractedDocument }>(
      "extract-worker",
      { path, ext, tess: "", mode: "extract", bytes, maxBytes: MAX_FILE_BYTES },
      signal ? AbortSignal.any([signal, limit]) : limit,
    );
    return document;
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : "";
    // Too big once opened (a zip bomb, a worker out of memory) and too slow both read as a file this chat cannot take.
    if (limit.aborted || ["archive-too-large", "source-worker-memory", "source-too-big"].includes(message))
      throw new IpcError("attach-too-big", "errors.attachTooBig", {}, limit.aborted ? "attach-extract-timeout" : message);
    throw error;
  }
}

const mimeFor: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

type ImageMime = VisionMime;
const extFor: Record<ImageMime, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/**
 * Suffix on the attachment row of an original that has a smaller copy beside it. The row keeps the true type
 * for the record, and the suffix stops a resend from sending both. HEIC needs none, since no model takes it.
 */
export const ORIGINAL_SUFFIX = ";original";

export type PreparedFiles = {
  sourceIds: string[];
  notes: string[];
  /**
   * `sha` is what the model got and the chat shows. `original` is the file as picked, kept when `sha` is a
   * fitted copy (a HEIC, or a photo resized to provider limits). `resizedFrom` says how far it was cut down.
   */
  images: Array<{
    mediaType: ImageMime;
    data: string;
    sha: string;
    original?: { sha: string; mime: string };
    resizedFrom?: { width: number; height: number; bytes: number };
  }>;
};

/** Files read and extracted but not stored. `commitStaged` stores them. */
export type StagedFiles = Pick<PreparedFiles, "notes" | "images"> & {
  blobs: StagedBlob[];
  documents: StagedDocument[];
};
type StagedBlob = { sha: string; bytes: Uint8Array; mime: string; ext: string };
type StagedDocument = { filePath: string; ext: string; bytes: Uint8Array; extracted: ExtractedDocument };

/** Reads and extracts a set of files, then stores it. A caller with more to write in the same step uses `stageFiles` and `commitStaged`. */
export async function prepareFiles(...args: Parameters<typeof stageFiles>): Promise<PreparedFiles> {
  const staged = await stageFiles(...args);
  return { sourceIds: commitStaged(args[0], args[1], staged).sourceIds, notes: staged.notes, images: staged.images };
}

export async function stageFiles(
  _db: Database.Database,
  workspace: string,
  paths: string[],
  modelId: string,
  recognize: (
    bytes: Uint8Array,
    cachePath: string,
    signal?: AbortSignal,
  ) => Promise<string> = ocrBytes,
  signal?: AbortSignal,
  decodeHeic: (path: string, signal?: AbortSignal) => Promise<Uint8Array> = (path, signal) =>
    runSourceWorker<Uint8Array>("extract-worker", { path, ext: extname(path).toLowerCase(), mode: "pixels" }, signal),
  loadVision: (path: string, ext: string, signal?: AbortSignal) => Promise<VisionImage> = loadVisionImage,
  extractDocument: (path: string, ext: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<ExtractedDocument> = extractInWorker,
): Promise<StagedFiles> {
  signal?.throwIfAborted();
  if (paths.length > MAX_FILES) throw new Error("attach-too-many");
  let total = 0;
  for (const filePath of paths) {
    const size = statSync(filePath).size;
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
      throw new Error("attach-too-big");
  }
  // Everything is read and extracted first, and nothing is stored. A later file that fails, or a cancel, then leaves no
  // source, passage or blob behind from the earlier ones. Only after the whole set has been read does one commit store it.
  const notes: string[] = [];
  const prepared: PreparedFiles["images"] = [];
  const blobs: StagedBlob[] = [];
  const documents: StagedDocument[] = [];
  /** Names a blob for a later commit and returns its hash, which is the same one `putBlob` will give. */
  const stage = (bytes: Uint8Array, mime: string, ext: string): string => {
    const sha = sha256(bytes);
    blobs.push({ sha, bytes, mime, ext });
    return sha;
  };
  const seesImages = capabilityWarning(modelId, "vision") == null;
  for (const filePath of paths) {
    signal?.throwIfAborted();
    const ext = extname(filePath).toLowerCase();
    // A file that grew since the size check above is refused instead of read whole.
    const bytes = readBoundedSync(filePath, MAX_FILE_BYTES);
    if (images.has(ext)) {
      const heic = isHeicExt(ext);
      let fitted: VisionImage | undefined;
      if (seesImages) {
        try {
          fitted = await loadVision(filePath, ext, signal);
        } catch (error) {
          // A photo the model cannot take (too big to fit, or unreadable) is read locally, like for a text-only model.
          if (signal?.aborted || isAbort(error)) throw error;
        }
      }
      signal?.throwIfAborted();
      if (fitted) {
        const resized = fitted.resizedFrom != null;
        const sha = stage(fitted.bytes, fitted.mediaType, extFor[fitted.mediaType]);
        let original: { sha: string; mime: string } | undefined;
        if (heic || resized) {
          const mime = heic ? imageMime(ext) : (sniffImage(bytes) ?? imageMime(ext));
          original = {
            sha: stage(bytes, mime, ext),
            mime: heic ? mime : `${mime}${ORIGINAL_SUFFIX}`,
          };
        }
        prepared.push({
          mediaType: fitted.mediaType,
          data: Buffer.from(fitted.bytes).toString("base64"),
          sha,
          ...(original ? { original } : {}),
          ...(fitted.resizedFrom ? { resizedFrom: fitted.resizedFrom } : {}),
        });
        continue;
      }
      const pixels = heic ? await decodeHeic(filePath, signal) : bytes;
      signal?.throwIfAborted();
      const mime = (heic ? "image/png" : mimeFor[ext] ?? "image/png") as ImageMime;
      const original = heic ? { sha: stage(bytes, imageMime(ext), ext), mime: imageMime(ext) } : undefined;
      const sha = stage(pixels, mime, heic ? ".png" : ext);
      prepared.push({
        mediaType: mime,
        data: "",
        sha,
        ...(original ? { original } : {}),
      });
      let text: string;
      try {
        text = await recognize(pixels, join(workspace, "runtimes", "tesseract"), signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        // The language data is the student's to download. Say so, instead of a failed turn with no reason.
        if (message === "ocr-data-missing" || message === "ocr-data-integrity")
          throw new IpcError(message, message === "ocr-data-missing" ? "sources.ocrDataMissing" : "sources.ocrDataIntegrity");
        throw error;
      }
      signal?.throwIfAborted();
      if (text) notes.push(text);
      continue;
    }
    const extracted = await extractDocument(filePath, ext, bytes, signal);
    signal?.throwIfAborted();
    documents.push({ filePath, ext, bytes, extracted });
  }
  signal?.throwIfAborted();
  return { notes, images: prepared, blobs, documents };
}

/**
 * Stores the staged set in one step with no await in it. The sources, passages and their hidden flag go in one
 * transaction, so none is visible to the library, not even for an instant, and a failure leaves none. `persist` runs
 * inside that same transaction with the new source ids, so a caller can write its own rows (a chat's scope, message
 * and attachments) atomically with them: if `persist` throws, the sources and passages roll back too. Blobs are files,
 * so they cannot join the transaction; on failure the ones this call made new are removed. A blob that was already
 * there may belong to a stored source, so it is never touched. Nothing else runs between the check for what is new
 * and the writes, so no row can come to reference a blob this call is about to undo.
 * Ceiling: a crash between the file writes and the transaction leaves unreferenced blob files until the workspace is deleted.
 */
export function commitStaged<T = undefined>(
  db: Database.Database,
  workspace: string,
  { blobs, documents }: Pick<StagedFiles, "blobs" | "documents">,
  persist?: (sourceIds: string[]) => T,
): { sourceIds: string[]; value: T } {
  const fresh = new Set<string>();
  for (const sha of [...blobs.map((blob) => blob.sha), ...documents.map((doc) => sha256(doc.bytes))])
    if (!hasBlob(workspace, sha)) fresh.add(sha);
  try {
    for (const blob of blobs) putBlob(workspace, blob.bytes, blob.mime, blob.ext);
    return db.transaction(() => {
      const sourceIds = documents.map(({ filePath, ext, bytes, extracted }) => {
        const source = storeExtracted(db, workspace, {
          title: basename(filePath, ext),
          kind: kindFor(ext),
          mime: documentMime(ext),
          ext,
          bytes,
          extracted,
        });
        db.prepare(`UPDATE sources SET library = 0 WHERE id = ?`).run(source.sourceId);
        return source.sourceId;
      });
      return { sourceIds, value: persist?.(sourceIds) as T };
    })();
  } catch (error) {
    for (const sha of fresh) removeBlob(workspace, sha);
    throw error;
  }
}

/** Fitted copies by blob hash, so a chat that resends the same photo each turn decodes it at most once. */
const fittedCache = new Map<string, { mediaType: ImageMime; data: string }>();
const FITTED_CACHE_SIZE = 8;
/** Images a turn resends. 4 fitted copies stay near 8 MB of base64. */
const SAVED_LIMIT = 4;

/** Why a saved image was left out of a turn, so the student is told instead of the context silently shrinking. */
export type SkippedImage = "too-large" | "unreadable" | "over-limit";

/**
 * The chat's latest images, each fitted to provider limits. New attachments are stored already fitted, so
 * those pass through. A row saved before fitting existed can hold up to 15 MB, and that one is fitted in the
 * extract worker, once per hash, so core stays free. An image that cannot be sent is listed in `skipped`
 * with the reason, and the turn still goes ahead with the rest.
 */
export async function savedImages(
  db: Database.Database,
  workspace: string,
  chatId: string,
  signal?: AbortSignal,
  fit: (path: string, ext: string, signal?: AbortSignal) => Promise<VisionImage> = loadVisionImage,
): Promise<{ images: Array<{ type: "image"; mediaType: ImageMime; data: string }>; skipped: SkippedImage[] }> {
  // Exact types only. A HEIC original, or a `;original` row, is not sent.
  const rows = db
    .prepare(
      `SELECT a.blob_sha AS sha, a.mime AS mime
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.chat_id = ? AND a.mime IN ('image/png', 'image/jpeg', 'image/webp')
       ORDER BY a.created_at DESC
       LIMIT ?`,
    )
    .all(chatId, SAVED_LIMIT + 1) as Array<{ sha: string; mime: ImageMime }>;
  const images: Array<{ type: "image"; mediaType: ImageMime; data: string }> = [];
  const skipped: SkippedImage[] = [];
  if (rows.length > SAVED_LIMIT) skipped.push("over-limit");
  for (const row of rows.slice(0, SAVED_LIMIT)) {
    signal?.throwIfAborted();
    let image = fittedCache.get(row.sha);
    if (!image) {
      try {
        const fitted = await fit(readBlob(workspace, row.sha).file, extFor[row.mime], signal);
        image = { mediaType: fitted.mediaType, data: Buffer.from(fitted.bytes).toString("base64") };
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw error;
        const message = error instanceof Error ? error.message : "";
        skipped.push(message === "vision-image-too-large" || message === "source-too-big" ? "too-large" : "unreadable");
        continue;
      }
      if (fittedCache.size >= FITTED_CACHE_SIZE) fittedCache.delete(fittedCache.keys().next().value!);
      fittedCache.set(row.sha, image);
    }
    images.push({ type: "image", ...image });
  }
  return { images, skipped };
}
