import { copyFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const SOURCE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SHA = /^[0-9a-f]{64}$/;

export type OpenCopy = { sourceId: string; sha: string };

/**
 * The copies "Apri il file" hands to the system's apps. A stored file is kept under its hash with no extension, so the
 * app gets a copy under the file's own name: `<root>/<sourceId>/<sha>/<name>`. The folders are the record, so a copy an
 * earlier run could not remove is found at the next start. Main removes a copy when core no longer has that file in the
 * Library (removed or replaced), when the workspace is wiped or replaced, when the app quits and at the next start. A
 * copy an app still holds open (Windows refuses to delete it) stays until one of the next tries.
 */
export function openCopies(
  root: string,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
) {
  /** Removes one entry; false when something holds it. */
  const drop = (path: string): boolean => {
    try {
      remove(path);
      return true;
    } catch {
      return false;
    }
  };
  const dropCopy = (copy: OpenCopy): boolean => {
    const ok = drop(join(root, copy.sourceId, copy.sha));
    // The source's folder goes with its last copy.
    if (ok && readdirSync(join(root, copy.sourceId)).length === 0) drop(join(root, copy.sourceId));
    return ok;
  };
  const list = (): OpenCopy[] => {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SOURCE_ID.test(entry.name))
      .flatMap((entry) =>
        readdirSync(join(root, entry.name), { withFileTypes: true })
          .filter((sub) => sub.isDirectory() && SHA.test(sub.name))
          .map((sub) => ({ sourceId: entry.name, sha: sub.name })),
      );
  };
  return {
    list,
    /**
     * Copies `from` to `<root>/<sourceId>/<sha>/<name>` and returns that path, or null when an id or the name would
     * leave the folder. The source's copy of a file it no longer holds goes first.
     */
    async make(sourceId: string, sha: string, from: string, name: string): Promise<string | null> {
      if (!SOURCE_ID.test(sourceId) || !SHA.test(sha) || basename(name) !== name || name === "." || name === "..") return null;
      for (const copy of list()) if (copy.sourceId === sourceId && copy.sha !== sha) dropCopy(copy);
      const folder = join(root, sourceId, sha);
      const path = join(folder, name);
      await mkdir(folder, { recursive: true });
      try {
        await copyFile(from, path);
      } catch (err) {
        // An app holding the copy from an earlier open keeps it from being written over. It has the same bytes.
        if (!existsSync(path)) throw err;
      }
      return path;
    },
    /** Removes the copies `keep` says no. Returns how many could not be removed. */
    async prune(keep: (copy: OpenCopy) => Promise<boolean>): Promise<number> {
      let left = 0;
      for (const copy of list()) if (!(await keep(copy)) && !dropCopy(copy)) left += 1;
      return left;
    },
    /** Removes every copy, and anything else in the folder. Returns how many entries could not be removed. */
    removeAll(): number {
      if (!existsSync(root)) return 0;
      let left = 0;
      for (const entry of readdirSync(root)) if (!drop(join(root, entry))) left += 1;
      return left;
    },
  };
}
