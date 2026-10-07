import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { MAX_IMAGE_BYTES } from "../../shared/source-types";
import { listImportable, MAX_FOLDER_FILES } from "./folder";
import { sourceHandlers } from "./handlers";
import { hashFiles, sha256 } from "./quality";
import type { runSourceWorker } from "./worker-client";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-scan-"));
  dirs.push(dir);
  return dir;
};

describe("source reads stay bounded and off the core thread", () => {
  it("hashes by streaming and gives null to a file that is missing, a folder, or over the cap", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "a.txt"), "alpha");
    writeFileSync(join(dir, "big.txt"), "0123456789");
    mkdirSync(join(dir, "sub"));
    const hashes = await hashFiles(
      [join(dir, "a.txt"), join(dir, "big.txt"), join(dir, "sub"), join(dir, "missing.txt")],
      6,
    );
    expect(hashes).toEqual([sha256(new TextEncoder().encode("alpha")), null, null, null]);
  });

  it("caps a folder walk by file count", () => {
    const dir = scratch();
    for (let index = 0; index < MAX_FOLDER_FILES + 5; index += 1) writeFileSync(join(dir, `n${index}.txt`), "");
    const listed = listImportable(dir);
    expect(listed.files).toHaveLength(MAX_FOLDER_FILES);
    expect(listed.cappedFiles).toBe(true);
  });

  it("scans a folder through the worker, marks duplicates, and drops files outside the grant", async () => {
    const dir = scratch();
    const seen = join(dir, "seen.txt");
    const fresh = join(dir, "fresh.txt");
    const outside = join(dir, "outside.txt");
    writeFileSync(seen, "already in the library");
    writeFileSync(fresh, "new material");
    writeFileSync(outside, "not granted");
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
       VALUES ('s', 'txt', 'seen', ?, 'text/plain', 'ready', 1, 1)`,
    ).run(sha256(new TextEncoder().encode("already in the library")));
    const calls: unknown[] = [];
    const work = (async (_name: string, input: { paths: string[]; maxBytes: number }) => {
      calls.push(input);
      return hashFiles(input.paths, input.maxBytes);
    }) as unknown as typeof runSourceWorker;
    const authorize = (path: string) => {
      if (path === outside) throw new Error("file-access-denied");
      return path;
    };
    const handlers = sourceHandlers(db, dir, undefined, authorize, work);
    const found = await handlers.scanFolder({ path: dir });
    expect(found).toEqual({
      files: [
        { path: fresh, name: "fresh.txt", duplicate: false },
        { path: seen, name: "seen.txt", duplicate: true },
      ],
      cappedFiles: false,
      cappedDepth: false,
      limit: MAX_FOLDER_FILES,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mode: "hash", paths: [fresh, seen] });
    db.close();
  });

  it("tells the student when a folder scan was cut, instead of listing a silent subset", async () => {
    const dir = scratch();
    for (let index = 0; index < MAX_FOLDER_FILES + 3; index += 1) writeFileSync(join(dir, `n${index}.txt`), "");
    const db = openDatabase(":memory:");
    const work = (async (_name: string, input: { paths: string[] }) =>
      input.paths.map(() => null)) as unknown as typeof runSourceWorker;
    const found = await sourceHandlers(db, dir, undefined, undefined, work).scanFolder({ path: dir });
    expect(found.files).toHaveLength(MAX_FOLDER_FILES);
    expect(found).toMatchObject({ cappedFiles: true, cappedDepth: false, limit: MAX_FOLDER_FILES });
    db.close();
  });

  it("hashes and decodes a preview in the worker, and refuses an oversize photo before it", async () => {
    const dir = scratch();
    const photo = join(dir, "note.png");
    writeFileSync(photo, "png");
    const huge = join(dir, "huge.jpg");
    writeFileSync(huge, "");
    truncateSync(huge, MAX_IMAGE_BYTES + 1);
    const db = openDatabase(":memory:");
    const calls: unknown[] = [];
    const work = (async (_name: string, input: unknown) => {
      calls.push(input);
      return { sha: "f".repeat(64), variance: 3 };
    }) as unknown as typeof runSourceWorker;
    const handlers = sourceHandlers(db, dir, undefined, undefined, work);
    expect(await handlers.preview({ path: photo })).toEqual({ duplicate: false, blurry: true });
    expect(calls).toEqual([{ path: photo, ext: ".png", mode: "quality", maxBytes: MAX_IMAGE_BYTES }]);
    await expect(handlers.preview({ path: huge })).rejects.toMatchObject({ messageKey: "sources.tooBig" });
    expect(calls).toHaveLength(1);
    db.close();
  });

  it("points a preview at the newest usable source with the same file, never a removed or failed one", async () => {
    const dir = scratch();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "same bytes");
    const sha = sha256(new TextEncoder().encode("same bytes"));
    const db = openDatabase(":memory:");
    const insert = db.prepare(
      `INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
       VALUES (?, 'text', ?, ?, 'text/plain', ?, ?, ?)`,
    );
    const work = (async () => ({ sha, variance: null })) as unknown as typeof runSourceWorker;
    const handlers = sourceHandlers(db, dir, undefined, undefined, work);
    // Nothing yet: not a duplicate, nothing to reuse.
    expect(await handlers.preview({ path: file })).toEqual({ duplicate: false, blurry: false });
    insert.run("removed", "removed", sha, "removed", 4, 4);
    insert.run("failed", "failed", sha, "failed", 5, 5);
    expect(await handlers.preview({ path: file })).toEqual({ duplicate: false, blurry: false });
    insert.run("old", "old", sha, "ready", 1, 1);
    insert.run("new", "new", sha, "extracting", 2, 2);
    insert.run("other", "other", "0".repeat(64), "ready", 3, 3);
    expect(await handlers.preview({ path: file })).toEqual({
      duplicate: true,
      blurry: false,
      existingSourceId: "new",
    });
    db.close();
  });
});
