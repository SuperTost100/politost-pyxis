import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type Database from "better-sqlite3";

/** Below this Laplacian variance a photo is treated as blurry. */
export const BLURRY_BELOW = 40;

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

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
 */
export function existingSourceFor(
  db: Database.Database,
  sha: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM sources
       WHERE blob_sha = ? AND status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(sha) as { id: string } | undefined;
  return row?.id ?? null;
}

export function isDuplicateBlob(db: Database.Database, sha: string): boolean {
  return existingSourceFor(db, sha) != null;
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
