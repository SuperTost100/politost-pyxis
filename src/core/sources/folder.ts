import { opendirSync, type Dir } from "node:fs";
import { extname, join } from "node:path";
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
 * Walk a folder and keep files Pyxis can import. Hidden names are skipped, and so are symlinks.
 * The walk is capped by file count, depth and every entry it reads, so a huge tree (a `node_modules`, a Downloads
 * folder) cannot hold the core thread, and says when it was cut. Folders are read a few entries at a time, so even
 * one folder with a million files stops at the cap.
 */
export function listImportable(root: string, maxEntries = MAX_FOLDER_ENTRIES): FolderListing {
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
