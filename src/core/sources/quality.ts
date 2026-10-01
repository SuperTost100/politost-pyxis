import { createHash } from "node:crypto";
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

export function isDuplicateBlob(db: Database.Database, sha: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS n FROM sources WHERE blob_sha = ? AND status != 'removed'`,
    )
    .get(sha);
  return row != null;
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
