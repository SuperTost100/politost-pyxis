import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type Database from "better-sqlite3";
import { putBlob, readBlob } from "../blobs";
import { capabilityWarning } from "../engine/capabilities";
import { importDocumentFile } from "../sources/documents";
import { runSourceWorker } from "../sources/worker-client";
import { isHeicExt, imageMime } from "../sources/heic";
import { recognizeImage } from "../sources/recognize";

const images = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"]);
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

const mimeFor: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export type PreparedFiles = {
  sourceIds: string[];
  notes: string[];
  images: Array<{ mediaType: ImageMime; data: string; sha: string; original?: { sha: string; mime: string } }>;
};

export async function prepareFiles(
  db: Database.Database,
  workspace: string,
  paths: string[],
  modelId: string,
  recognize: (
    bytes: Uint8Array,
    cachePath: string,
  ) => Promise<string> = recognizeImage,
  signal?: AbortSignal,
  decodeHeic: (path: string, signal?: AbortSignal) => Promise<Uint8Array> = (path, signal) =>
    runSourceWorker<Uint8Array>("extract-worker", { path, ext: extname(path).toLowerCase(), mode: "pixels" }, signal),
): Promise<PreparedFiles> {
  signal?.throwIfAborted();
  if (paths.length > MAX_FILES) throw new Error("attach-too-many");
  let total = 0;
  for (const filePath of paths) {
    const size = statSync(filePath).size;
    total += size;
    if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES)
      throw new Error("attach-too-big");
  }
  const sourceIds: string[] = [];
  const notes: string[] = [];
  const prepared: PreparedFiles["images"] = [];
  const seesImages = capabilityWarning(modelId, "vision") == null;
  for (const filePath of paths) {
    signal?.throwIfAborted();
    const ext = extname(filePath).toLowerCase();
    const bytes = new Uint8Array(readFileSync(filePath));
    if (images.has(ext)) {
      const heic = isHeicExt(ext);
      const pixels = heic ? await decodeHeic(filePath, signal) : bytes;
      signal?.throwIfAborted();
      const mime = (heic ? "image/png" : mimeFor[ext] ?? "image/png") as ImageMime;
      const original = heic ? { sha: putBlob(workspace, bytes, imageMime(ext), ext), mime: imageMime(ext) } : undefined;
      const sha = putBlob(workspace, pixels, mime, heic ? ".png" : ext);
      prepared.push({
        mediaType: mime,
        data: seesImages ? Buffer.from(pixels).toString("base64") : "",
        sha,
        ...(original ? { original } : {}),
      });
      if (seesImages) continue;
      const text = await recognize(
        pixels,
        join(workspace, "runtimes", "tesseract"),
      );
      signal?.throwIfAborted();
      if (text) notes.push(text);
      continue;
    }
    const stored = await importDocumentFile(db, workspace, filePath);
    db.prepare(`UPDATE sources SET library = 0 WHERE id = ?`).run(
      stored.sourceId,
    );
    sourceIds.push(stored.sourceId);
  }
  signal?.throwIfAborted();
  return { sourceIds, notes, images: prepared };
}

export function savedImages(
  db: Database.Database,
  workspace: string,
  chatId: string,
): Array<{ type: "image"; mediaType: ImageMime; data: string }> {
  const rows = db
    .prepare(
      `SELECT a.blob_sha AS sha, a.mime AS mime
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.chat_id = ? AND a.mime LIKE 'image/%'
       ORDER BY a.created_at DESC
       LIMIT 4`,
    )
    .all(chatId) as Array<{ sha: string; mime: string }>;
  const out: Array<{ type: "image"; mediaType: ImageMime; data: string }> = [];
  for (const row of rows) {
    if (
      row.mime !== "image/png" &&
      row.mime !== "image/jpeg" &&
      row.mime !== "image/webp"
    ) {
      continue;
    }
    const bytes = readFileSync(readBlob(workspace, row.sha).file);
    out.push({
      type: "image",
      mediaType: row.mime,
      data: Buffer.from(bytes).toString("base64"),
    });
  }
  return out;
}
