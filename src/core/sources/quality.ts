import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type Database from "better-sqlite3";

/** Below this Laplacian variance a photo is treated as blurry. */
const BLURRY_BELOW = 40;

export function laplacianVariance(
  gray: Uint8Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value =
        4 * (gray[index] ?? 0) -
        (gray[index - 1] ?? 0) -
        (gray[index + 1] ?? 0) -
        (gray[index - width] ?? 0) -
        (gray[index + width] ?? 0);
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Bytes as base64, read in place rather than copied first. */
export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** SHA-256 of bytes, or of a string's UTF-8, as hex. */
export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-256 of each file by streaming, so a folder of large PDFs never sits in memory or blocks the caller.
 * A file that is missing, not a regular file, or over `maxBytes` gets null.
 */
export async function hashFiles(paths: string[], maxBytes: number): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxBytes) {
        out.push(null);
        continue;
      }
      const hash = createHash("sha256");
      let seen = 0;
      for await (const chunk of createReadStream(path)) {
        seen += (chunk as Buffer).length;
        // A file that grows while it is read stops at the cap.
        if (seen > maxBytes) throw new Error("source-too-big");
        hash.update(chunk as Buffer);
      }
      out.push(hash.digest("hex"));
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * The newest source whose current file has this hash and that is still usable: reading, waiting or ready.
 * A removed, failed, cancelled or interrupted source does not count, so importing that file again starts over.
 * A file a linked folder reads in place has no stored copy, so its hash is on the folder's row, and counts while the
 * file is still there. A chat attachment or a plan file can leave a usable source out of the library
 * (`library = 0`). `libraryOnly` skips those, for answers about what the library holds. A flow that reuses a hidden
 * source must promote it.
 */
export function existingSourceFor(
  db: Database.Database,
  sha: string,
  libraryOnly = false,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM sources
       WHERE (blob_sha = ?
              OR id IN (SELECT source_id FROM linked_files WHERE content_hash = ? AND missing_at IS NULL))
         AND status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')
         AND (? = 0 OR library = 1)
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sha, sha, libraryOnly ? 1 : 0) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The query behind `existingLinkFor`. The import jobs are filtered by address first, in a subquery that does not refer
 * to the outer row, so SQLite runs it once. Written as a correlated `EXISTS` it scanned every import job once per
 * source, which a library of linked folders (one source and one job per file) turns into minutes.
 */
export const EXISTING_LINK_SQL = `SELECT s.id FROM sources s
  WHERE s.library = 1 AND s.status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')
    AND (s.origin_url = @url
         OR s.id IN (SELECT json_extract(j.params_json, '$.sourceId') FROM jobs j
                     WHERE j.kind IN ('source-import', 'source-import-vision')
                       AND json_extract(j.params_json, '$.url') = @url))
  ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`;

/**
 * The usable library source saved from this web address, so saving a link twice gives one source. A link stores no
 * bytes until its page is fetched, so the address is looked up on the source (the page's final address, once fetched)
 * and on the import job that is still to fetch it.
 */
export function existingLinkFor(db: Database.Database, url: string): string | null {
  const row = db.prepare(EXISTING_LINK_SQL).get({ url }) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Whether the library already shows a usable source with this file. */
export function isDuplicateBlob(db: Database.Database, sha: string): boolean {
  return existingSourceFor(db, sha, true) != null;
}

export function qualityFlags(input: {
  duplicate: boolean;
  variance: number | null;
}): Array<"duplicate" | "blurry"> {
  const flags: Array<"duplicate" | "blurry"> = [];
  if (input.duplicate) flags.push("duplicate");
  if (input.variance != null && input.variance < BLURRY_BELOW) flags.push("blurry");
  return flags;
}
