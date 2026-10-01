import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { laplacianVariance, qualityFlags, isDuplicateBlob } from "./quality";

describe("source quality", () => {
  it("treats a flat photo as blurry and a checker as sharp", () => {
    const flat = new Uint8Array(32 * 32).fill(180);
    const sharp = new Uint8Array(32 * 32);
    for (let i = 0; i < sharp.length; i += 1) sharp[i] = (i + Math.floor(i / 32)) % 2 ? 0 : 255;
    expect(laplacianVariance(flat, 32, 32)).toBeLessThan(40);
    expect(laplacianVariance(sharp, 32, 32)).toBeGreaterThan(40);
    expect(qualityFlags({ duplicate: false, variance: 0 })).toEqual(["blurry"]);
    expect(qualityFlags({ duplicate: true, variance: 1000 })).toEqual(["duplicate"]);
  });

  it("matches a file already in the library by hash", () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    db.prepare(
      `INSERT INTO sources (id, kind, title, blob_sha, status, created_at, updated_at)
       VALUES (?, 'pdf', 'Notes', ?, 'ready', ?, ?)`,
    ).run(uuidv7(now), "abc", now, now);
    expect(isDuplicateBlob(db, "abc")).toBe(true);
    expect(isDuplicateBlob(db, "other")).toBe(false);
  });
});
