import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { addDocumentVersion, extractByExt, mimeFor } from "./documents";
import type { StoredSource } from "./documents";

export function renameSource(
  db: Database.Database,
  sourceId: string,
  title: string,
): void {
  const name = title.trim();
  if (!name) throw new Error("title-empty");
  const result = db
    .prepare(
      `UPDATE sources SET title = ?, updated_at = ? WHERE id = ? AND status != 'removed'`,
    )
    .run(name, Date.now(), sourceId);
  if (result.changes === 0) throw new Error("source-missing");
}

export function promoteSource(db: Database.Database, sourceId: string): void {
  const result = db
    .prepare(
      `UPDATE sources SET library = 1, updated_at = ? WHERE id = ? AND status != 'removed'`,
    )
    .run(Date.now(), sourceId);
  if (result.changes === 0) throw new Error("source-missing");
}

/** How many plans use the source. Removing, replacing or re-reading it changes what their items cite. */
export function plansUsing(db: Database.Database, sourceId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM plan_sources WHERE source_id = ?`)
    .get(sourceId) as { n: number };
  return row.n;
}

export function sourceInUse(db: Database.Database, sourceId: string): boolean {
  return plansUsing(db, sourceId) > 0;
}

const EXT_FOR_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

/** The extension a stored original had, from the type kept on its source row. The blob store names files by hash. */
export function extForMime(mime: string | null): string | null {
  return (mime && EXT_FOR_MIME[mime]) || null;
}

/** Hide the source. Passages stay so old citations still have their text. */
export function removeSource(
  db: Database.Database,
  sourceId: string,
  confirmed: boolean,
): { removed: boolean; inUse: boolean } {
  const row = db
    .prepare(`SELECT id FROM sources WHERE id = ? AND status != 'removed'`)
    .get(sourceId);
  if (!row) throw new Error("source-missing");
  const inUse = sourceInUse(db, sourceId);
  if (inUse && !confirmed) return { removed: false, inUse: true };
  const now = Date.now();
  db.transaction(() => {
    db.prepare(`DELETE FROM plan_sources WHERE source_id = ?`).run(sourceId);
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(`syllabus.${sourceId}`);
    db.prepare(`UPDATE sources SET status = 'removed', updated_at = ? WHERE id = ?`).run(
      now,
      sourceId,
    );
  })();
  return { removed: true, inUse };
}

export async function replaceSourceFile(
  db: Database.Database,
  workspace: string,
  sourceId: string,
  filePath: string,
): Promise<StoredSource> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const ext = extname(filePath).toLowerCase();
  const extracted = await extractByExt(bytes, ext);
  return addDocumentVersion(db, workspace, sourceId, {
    title: basename(filePath, ext),
    mime: mimeFor(ext),
    ext,
    bytes,
    extracted,
  });
}
