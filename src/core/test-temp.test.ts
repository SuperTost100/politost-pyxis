import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTree } from "../../scripts/run-tmpdir";
import { sharedTempDir, tempDir } from "./test-temp";

describe("temp folders for tests", () => {
  const seen: string[] = [];
  const shared = sharedTempDir("pyxis-shared-check-");

  it("gives each test a folder inside the run's TMPDIR", () => {
    const dir = tempDir("pyxis-check-");
    seen.push(dir);
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("has removed the previous test's folder, and keeps the shared one", () => {
    expect(existsSync(seen[0]!)).toBe(false);
    expect(existsSync(shared)).toBe(true);
  });

  // Windows has no chmod for folders.
  it.skipIf(process.platform === "win32")("removes a read-only folder tree", () => {
    const dir = tempDir("pyxis-check-locked-");
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "file.txt"), "x");
    chmodSync(locked, 0o500);
    removeTree(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
