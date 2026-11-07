import { lstatSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { strictlyInside } from "../path-inside";

/**
 * Where a source read from a linked folder lives, or null for a source Pyxis keeps a copy of. `missing` is set when the
 * last look at the folder did not find the file.
 */
export function linkedFile(db: Database.Database, sourceId: string): { path: string; missing: boolean } | null {
  const row = db
    .prepare(
      `SELECT f.path AS root, l.rel_path AS rel, l.missing_at AS missingAt
       FROM linked_files l JOIN linked_folders f ON f.id = l.folder_id WHERE l.source_id = ?`,
    )
    .get(sourceId) as { root: string; rel: string; missingAt: number | null } | undefined;
  return row ? { path: join(row.root, row.rel), missing: row.missingAt !== null } : null;
}

/**
 * The path to read a linked source's file from, checked now: a regular file inside its folder, not a link. A file that
 * is gone, or turned into something else, fails as `source-file-missing`, and nothing is read.
 */
export function readableLinkedPath(db: Database.Database, sourceId: string): string {
  const row = db
    .prepare(
      `SELECT f.path AS root, l.rel_path AS rel FROM linked_files l JOIN linked_folders f ON f.id = l.folder_id
       WHERE l.source_id = ?`,
    )
    .get(sourceId) as { root: string; rel: string } | undefined;
  if (!row) throw new Error("source-file-missing");
  const path = join(row.root, row.rel);
  try {
    if (!strictlyInside(row.root, path) || !lstatSync(path).isFile()) throw new Error("not-a-file");
  } catch {
    throw new Error("source-file-missing");
  }
  return path;
}
