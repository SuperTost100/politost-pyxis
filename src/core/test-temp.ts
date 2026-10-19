import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, onTestFinished } from "vitest";
import { removeTree } from "../../scripts/run-tmpdir";

/** A new temp folder that is removed (read-only parts included) when the current test or hook finishes. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => removeTree(dir));
  return dir;
}

/** Like tempDir, for a folder that several tests share: call it in a describe or at module level; it goes after the last test there. */
export function sharedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  afterAll(() => removeTree(dir));
  return dir;
}
