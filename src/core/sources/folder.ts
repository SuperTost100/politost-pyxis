import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { MAX_FOLDER_DEPTH, MAX_FOLDER_FILES, SOURCE_EXTENSIONS } from "../../shared/source-types";

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
};

/**
 * Walk a folder and keep files Pyxis can import. Hidden names are skipped, and so are symlinks.
 * The walk is capped by file count and depth, so a huge tree cannot hold the core thread, and says when it was cut.
 */
export function listImportable(root: string): FolderListing {
  const found: string[] = [];
  let cappedFiles = false;
  let cappedDepth = false;
  const walk = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (cappedFiles) return;
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
  };
  walk(root, 0);
  return { files: found.sort(), cappedFiles, cappedDepth };
}
