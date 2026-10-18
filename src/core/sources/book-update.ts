import type Database from "better-sqlite3";
import { isNewerBook, isSemverVersion, type CatalogBook } from "./books";
import { existingSourceFor } from "./quality";

/** A library book whose import or update is still being read. Its update is under way, not offered again. */
const WORKING = ["queued", "extracting", "indexing"];

/**
 * Links smartbooks imported before Pyxis recorded the catalog link (0.2.x) to the catalog it has just read. A package
 * whose SHA-256 the catalog lists is that book and version. The catalog only lists each book's current version, so a
 * copy it has moved past is linked by the `id` and semver `version` its own `smartbook.json` carries: the books
 * repository makes the package id the catalog id. A removed source is left alone.
 */
export function linkCatalogBooks(
  db: Database.Database,
  books: CatalogBook[],
): void {
  const bySha = new Map(books.map((book) => [book.sha256, book]));
  const ids = new Set(books.map((book) => book.id));
  const rows = db
    .prepare(
      `SELECT s.id, s.blob_sha AS sha, b.meta_json AS meta FROM sources s
       LEFT JOIN smartbooks b ON b.source_id = s.id
       WHERE s.kind = 'smartbook' AND s.catalog_id IS NULL AND s.status != 'removed'`,
    )
    .all() as Array<{ id: string; sha: string | null; meta: string | null }>;
  const link = db.prepare(
    `UPDATE sources SET catalog_id = ?, catalog_version = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const exact = row.sha ? bySha.get(row.sha) : undefined;
    if (exact) {
      link.run(exact.id, exact.version, row.id);
      continue;
    }
    let meta: { id?: unknown; version?: unknown } = {};
    try {
      meta = row.meta ? (JSON.parse(row.meta) as typeof meta) : {};
    } catch {
      continue;
    }
    if (
      typeof meta.id === "string" &&
      ids.has(meta.id) &&
      typeof meta.version === "string" &&
      isSemverVersion(meta.version)
    )
      link.run(meta.id, meta.version, row.id);
  }
}

/**
 * The library source a catalog book already is, and whether a newer version can replace it in place. The exact
 * package counts first. Otherwise the newest usable library source linked to the book: `available` when it is ready
 * and older than the catalog, `running` while an update (or its first import) is being read. A linked source that is no
 * longer a smartbook is not the book: before 0.3.2, replacing a book with a document kept its catalog link.
 */
export function bookState(
  db: Database.Database,
  book: CatalogBook,
): { sourceId: string | null; update: "available" | "running" | null } {
  const exact = existingSourceFor(db, book.sha256, true);
  if (exact) return { sourceId: exact, update: null };
  const linked = db
    .prepare(
      `SELECT id, status, blob_sha AS sha, catalog_version AS version FROM sources
       WHERE catalog_id = ? AND kind = 'smartbook' AND library = 1 AND status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(book.id) as
    | { id: string; status: string; sha: string | null; version: string | null }
    | undefined;
  if (!linked) return { sourceId: null, update: null };
  if (!isNewerBook(book, linked)) return { sourceId: linked.id, update: null };
  if (linked.status === "ready")
    return { sourceId: linked.id, update: "available" };
  return {
    sourceId: linked.id,
    update: WORKING.includes(linked.status) ? "running" : null,
  };
}

/** The library or hidden source linked to a catalog book, for Add to reuse instead of downloading a second copy. */
export function linkedBookSource(
  db: Database.Database,
  catalogId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM sources WHERE catalog_id = ? AND kind = 'smartbook' AND status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')
       ORDER BY library DESC, created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(catalogId) as { id: string } | undefined;
  return row?.id ?? null;
}
