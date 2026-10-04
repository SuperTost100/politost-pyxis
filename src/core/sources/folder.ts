import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

export const IMPORT_EXTENSIONS = new Set([
  ".ptsb",
  ".pdf",
  ".docx",
  ".pptx",
  ".txt",
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".heif",
]);

/** Walk a folder and keep files Pyxis can import. Hidden names are skipped. */
export function listImportable(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        IMPORT_EXTENSIONS.has(extname(entry.name).toLowerCase())
      )
        found.push(full);
    }
  };
  walk(root);
  return found.sort();
}
