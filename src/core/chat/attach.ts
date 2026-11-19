import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type Database from "better-sqlite3";
import { hasBlob, putBlob, readBlob, removeBlob } from "../blobs";
import { base64, sha256 } from "../sources/quality";
import { ocrBytes, runSourceWorker } from "../sources/worker-client";
import { isHeicExt, imageMime } from "../sources/heic";
import {
  loadVisionImage,
  sniffImage,
  type VisionImage,
  type VisionMime,
} from "../sources/vision-image";
import { IpcError, isAbort } from "../../shared/ipc";
import type { TakenFiles } from "./held-files";

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
  /**
   * `sha` is what the model got and the chat shows. `original` is the file as picked, kept when `sha` is a
   * fitted copy (a HEIC, or a photo resized to provider limits). `resizedFrom` says how far it was cut down.
   * `data` is empty for a photo no model reads, which only has its recognised text.
   */
  images: Array<{
    mediaType: ImageMime;
    data: string;
    sha: string;
    original?: { sha: string; mime: string };
    resizedFrom?: { width: number; height: number; bytes: number };
  }>;
};

export type StagedBlob = { sha: string; bytes: Uint8Array; mime: string; ext: string };
type HeldPhoto = TakenFiles["photos"][number];

/** Turns a HEIC file into PNG pixels, in the extract worker. */
const decodeInWorker = (path: string, signal?: AbortSignal): Promise<Uint8Array> =>
  runSourceWorker<Uint8Array>("extract-worker", { path, ext: extname(path).toLowerCase(), mode: "pixels" }, signal);

/**
 * The stored and sent forms of a photo that was fitted when it was attached. `read` says whether the model that answers
 * takes images: when it does not, the photo is stored but nothing of it is sent, and its text comes from `recognise`.
 */
export async function stagePhoto(
  photo: HeldPhoto,
  read: boolean,
  signal?: AbortSignal,
  decodeHeic: (path: string, signal?: AbortSignal) => Promise<Uint8Array> = decodeInWorker,
): Promise<{ blobs: StagedBlob[]; image: PreparedFiles["images"][number] }> {
  const bytes = new Uint8Array(await readFile(photo.file));
  const heic = isHeicExt(photo.ext);
  const blobs: StagedBlob[] = [];
  /** Names a blob for the commit and returns its hash, which is the same one `putBlob` will give. */
  const stage = (data: Uint8Array, mime: string, ext: string): string => {
    const sha = sha256(data);
    blobs.push({ sha, bytes: data, mime, ext });
    return sha;
  };
  const { fitted } = photo;
  if (fitted) {
    const resized = fitted.resizedFrom != null;
    const sha = stage(fitted.bytes, fitted.mediaType, extFor[fitted.mediaType]);
    let original: { sha: string; mime: string } | undefined;
    if (heic || resized) {
      const mime = heic ? imageMime(photo.ext) : (sniffImage(bytes) ?? imageMime(photo.ext));
      original = { sha: stage(bytes, mime, photo.ext), mime: heic ? mime : `${mime}${ORIGINAL_SUFFIX}` };
    }
    return {
      blobs,
      image: {
        mediaType: fitted.mediaType,
        data: read ? base64(fitted.bytes) : "",
        sha,
        ...(original ? { original } : {}),
        ...(fitted.resizedFrom ? { resizedFrom: fitted.resizedFrom } : {}),
      },
    };
  }
  // No copy could be made for a model: the photo is kept as it is (decoded, for a HEIC) and read locally.
  const pixels = heic ? await decodeHeic(photo.file, signal) : bytes;
  const mime = (heic ? "image/png" : mimeFor[photo.ext] ?? "image/png") as ImageMime;
  const original = heic ? { sha: stage(bytes, imageMime(photo.ext), photo.ext), mime: imageMime(photo.ext) } : undefined;
  const sha = stage(pixels, mime, heic ? ".png" : photo.ext);
  return { blobs, image: { mediaType: mime, data: "", sha, ...(original ? { original } : {}) } };
}

/**
 * The text local OCR reads from a photo, for a chat whose model cannot see images and no other model of an available
 * tool can either. It is stored apart from the message and sent to the model as attached text.
 */
export async function recognisePhoto(
  photo: HeldPhoto,
  workspace: string,
  recognize: (bytes: Uint8Array, cachePath: string, signal?: AbortSignal) => Promise<string> = ocrBytes,
  signal?: AbortSignal,
  decodeHeic: (path: string, signal?: AbortSignal) => Promise<Uint8Array> = decodeInWorker,
): Promise<string> {
  const pixels = isHeicExt(photo.ext) ? await decodeHeic(photo.file, signal) : new Uint8Array(await readFile(photo.file));
  try {
    return (await recognize(pixels, join(workspace, "runtimes", "tesseract"), signal)).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // The language data is the student's to download. Say so, instead of a failed turn with no reason.
    const refused = { "ocr-data-missing": "sources.ocrDataMissing", "ocr-data-integrity": "sources.ocrDataIntegrity", "ocr-data-unreadable": "sources.ocrDataUnreadable" }[message];
    if (refused) throw new IpcError(message, refused);
    throw error;
  }
}

/**
 * Stores the photos' blobs and runs `persist` in one transaction with no await in it, so the message's rows and the
 * scope go in together. Blobs are files, so they cannot join the transaction; on failure the ones this call made new
 * are removed. A blob that was already there may belong to a stored source or another chat, so it is never touched.
 * Ceiling: a crash between the file writes and the transaction leaves unreferenced blob files until Free up space.
 */
export function commitStaged<T>(
  db: Database.Database,
  workspace: string,
  blobs: StagedBlob[],
  persist: () => T,
): T {
  const fresh = new Set<string>();
  for (const blob of blobs) if (!hasBlob(workspace, blob.sha)) fresh.add(blob.sha);
  try {
    for (const blob of blobs) putBlob(workspace, blob.bytes, blob.mime, blob.ext);
    return db.transaction(persist)();
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
        image = { mediaType: fitted.mediaType, data: base64(fitted.bytes) };
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
