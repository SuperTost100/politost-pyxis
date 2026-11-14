import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { test } from "node:test";

/**
 * Two source files in one folder whose names differ only by letter case, such as `PartPage.tsx` and `partPage.ts`.
 * An import without an extension (`./PartPage`) finds the wrong one on macOS and Windows, where the file system
 * ignores case, so the app builds on Linux and nowhere else.
 */
export function caseClashes(paths) {
  const stems = new Map();
  for (const path of paths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const stem = name.slice(0, name.indexOf(".") === -1 ? name.length : name.indexOf("."));
    const key = `${dirname(path)}/${stem.toLowerCase()}`;
    stems.set(key, (stems.get(key) ?? new Set()).add(stem));
  }
  return [...stems].filter(([, exact]) => exact.size > 1).map(([key, exact]) => `${dirname(key)}: ${[...exact].sort().join(", ")}`);
}

test("no two source files in a folder differ only by letter case", () => {
  const tracked = execFileSync("git", ["ls-files", "src", "tests", "scripts"], { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.deepEqual(caseClashes(tracked), []);
});

test("a clash is found whatever the extensions, and names that match exactly are not one", () => {
  assert.deepEqual(caseClashes(["a/PartPage.tsx", "a/partPage.ts", "a/partPage.test.ts", "a/PartPage.css", "b/partPage.ts"]), [
    "a: PartPage, partPage",
  ]);
  assert.deepEqual(caseClashes(["a/Dialog.tsx", "a/Dialog.css", "a/Dialog.test.tsx", "a/dialogFocus.ts"]), []);
});
