import { opendirSync, type Dir } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import { MAX_FOLDER_DEPTH, MAX_FOLDER_ENTRIES, MAX_FOLDER_FILES, SOURCE_EXTENSIONS } from "../../shared/source-types";

export const IMPORT_EXTENSIONS = new Set(
  SOURCE_EXTENSIONS.map((extension) => `.${extension}`),
);

export { MAX_FOLDER_DEPTH, MAX_FOLDER_FILES };

/** What a walk found, and whether a cap cut it short. The student is told, so a silent cut never hides material. */
export type FolderListing = {
  files: string[];
  /** A further importable file was left unlisted because the file cap was reached. */
  cappedFiles: boolean;
  /** A subfolder nested deeper than the depth cap was not read. */
  cappedDepth: boolean;
  /** The walk stopped after reading the entry cap's worth of files and folders, importable or not. */
  cappedEntries: boolean;
  /** A subfolder could not be read, for example a protected system folder, and was skipped. */
  unreadable: boolean;
};

/**
 * Walk a folder for a one-shot folder import (copy) and keep files Pyxis can import. A linked folder is read in full
 * by `walkImportable` instead. Hidden names are skipped, and so are symlinks.
 * The walk is capped by file count, depth and every entry it reads, so a huge tree (a `node_modules`, a Downloads
 * folder) cannot hold the core thread, and says when it was cut. Folders are read a few entries at a time, so even
 * one folder with a million files stops at the cap.
 */
export function listImportable(
  root: string,
  maxEntries = MAX_FOLDER_ENTRIES,
  /** Folders never walked into, such as the workspace when the student links a folder that holds it. */
  exclude: readonly string[] = [],
): FolderListing {
  const found: string[] = [];
  let cappedFiles = false;
  let cappedDepth = false;
  let cappedEntries = false;
  let unreadable = false;
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    let handle: Dir;
    try {
      handle = opendirSync(dir);
    } catch (err) {
      // The chosen folder itself must be readable; a subfolder that is not is skipped and reported.
      if (depth === 0) throw err;
      unreadable = true;
      return;
    }
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (cappedFiles || cappedEntries) return;
        visited += 1;
        if (visited > maxEntries) {
          cappedEntries = true;
          return;
        }
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (exclude.includes(full)) continue;
          if (depth >= MAX_FOLDER_DEPTH) cappedDepth = true;
          else walk(full, depth + 1);
        } else if (
          entry.isFile() &&
          IMPORT_EXTENSIONS.has(extname(entry.name).toLowerCase())
        ) {
          if (found.length >= MAX_FOLDER_FILES) cappedFiles = true;
          else found.push(full);
        }
      }
    } finally {
      handle.closeSync();
    }
  };
  walk(root, 0);
  return { files: found.sort(), cappedFiles, cappedDepth, cappedEntries, unreadable };
}

/** A file a walk found, with what its `lstat` said. `rel` is relative to the walked folder. */
export type WalkedFile = { path: string; rel: string; size: number; mtimeMs: number };

/** What a walk could not read: subfolders past the depth cap, and subfolders the system would not open. */
export type WalkCut = { depth: boolean; unreadable: boolean };

/** Files are handed over, and the event loop is let go, at least this often. */
const WALK_BATCH = 256;

/**
 * Walks a folder with no cap on files or entries, for a linked folder that is read in full. Hidden names and symlinks
 * are skipped, so a link can never lead the walk into a cycle, and folders deeper than `maxDepth` are not opened (the
 * cut says so). Folders are read through the thread pool a few entries at a time, and every `WALK_BATCH` entries the
 * walk waits for the next turn of the event loop, so a folder of any size never holds core. Files go to `onFiles` in
 * batches as they are found, with their size and time, and the walk waits for it before going on.
 *
 * `within` walks only that path inside `root` (a subfolder, or one file), as a watch reports a change there; its
 * depth counts from `root`. A `within` that is gone, hidden or not importable finds nothing. The root itself must be
 * readable; a subfolder that is not is skipped and reported.
 */
export async function walkImportable(
  root: string,
  options: {
    onFiles: (files: WalkedFile[]) => void | Promise<void>;
    /** Called with each subfolder found, relative to `root`, whether or not the depth lets the walk open it. */
    onFolder?: (rel: string) => void;
    exclude?: readonly string[];
    maxDepth: number;
    within?: string;
    /** Stops after reading this many entries, for a quick sample of a folder rather than a full read. */
    maxEntries?: number;
    signal?: AbortSignal;
  },
): Promise<WalkCut> {
  const cut: WalkCut = { depth: false, unreadable: false };
  const exclude = options.exclude ?? [];
  let files: string[] = [];
  let seen = 0;
  // A failure in `onFiles` ends the walk; it is not a folder that could not be read.
  let handedOver = false;
  /**
   * What `lstat` says about a path, or null when it is gone. Any other failure (no permission, a disk error) leaves
   * the walk unreadable, so a file that is there but could not be read is never taken for one that was deleted.
   */
  const statOf = (path: string) =>
    lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT" && err.code !== "ENOTDIR") cut.unreadable = true;
      return null;
    });
  const flush = async () => {
    const batch = files;
    files = [];
    const stats = await Promise.all(batch.map(statOf));
    options.signal?.throwIfAborted();
    const found: WalkedFile[] = [];
    batch.forEach((path, index) => {
      const stat = stats[index];
      // Turned into a link or a folder, or gone, since the folder was listed.
      if (stat?.isFile()) found.push({ path, rel: relative(root, path), size: stat.size, mtimeMs: stat.mtimeMs });
    });
    if (!found.length) return;
    try {
      await options.onFiles(found);
    } catch (err) {
      handedOver = true;
      throw err;
    }
  };
  const step = async () => {
    seen += 1;
    if (files.length >= WALK_BATCH) await flush();
    if (seen % WALK_BATCH === 0) {
      await setImmediate();
      options.signal?.throwIfAborted();
    }
  };
  const importable = (name: string) => IMPORT_EXTENSIONS.has(extname(name).toLowerCase());
  const stack: Array<{ dir: string; depth: number }> = [];
  if (options.within) {
    // A watch names a place with the system's own separator; a backslash on Linux is part of a name.
    const parts = options.within.split(sep).filter(Boolean);
    if (parts.some((part) => part.startsWith(".") || part === "..")) return cut;
    const start = join(root, ...parts);
    if (exclude.some((place) => start === place || start.startsWith(place + sep))) return cut;
    options.signal?.throwIfAborted();
    // Every folder on the way must be a real folder: one replaced by a link could lead outside `root`.
    for (let depth = 1; depth < parts.length; depth += 1)
      if (!(await statOf(join(root, ...parts.slice(0, depth))))?.isDirectory()) return cut;
    const stat = await statOf(start);
    if (stat?.isFile() && importable(start)) {
      if (parts.length - 1 > options.maxDepth) cut.depth = true;
      else files.push(start);
    }
    else if (stat?.isDirectory()) {
      if (parts.length > options.maxDepth) cut.depth = true;
      else stack.push({ dir: start, depth: parts.length });
    }
  } else stack.push({ dir: root, depth: 0 });
  const limit = options.maxEntries ?? Infinity;
  while (stack.length && seen < limit) {
    options.signal?.throwIfAborted();
    const { dir, depth } = stack.pop()!;
    let handle: Dir;
    try {
      handle = await opendir(dir, { bufferSize: 64 });
    } catch (err) {
      if (dir === root) throw err;
      cut.unreadable = true;
      continue;
    }
    const subfolders: string[] = [];
    try {
      for await (const entry of handle) {
        await step();
        if (seen > limit) break;
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (exclude.includes(full)) continue;
          options.onFolder?.(relative(root, full));
          if (depth >= options.maxDepth) cut.depth = true;
          else subfolders.push(full);
        } else if (entry.isFile() && importable(entry.name)) files.push(full);
      }
    } catch (err) {
      if (options.signal?.aborted || handedOver) throw err;
      // The folder stopped being readable while it was read: what it listed so far is kept.
      cut.unreadable = true;
    }
    // Popped in name order, so a walk reads the folder in the same order every time.
    subfolders.sort().reverse();
    for (const sub of subfolders) stack.push({ dir: sub, depth: depth + 1 });
  }
  await flush();
  return cut;
}
