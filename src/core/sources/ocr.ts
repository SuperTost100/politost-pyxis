import type Database from "better-sqlite3";
import { chunkText } from "./chunk";
import { uuidv7 } from "../../shared/ids";

export type OcrPage = { page: number; text: string };

function sourceStatus(
  db: Database.Database,
  sourceId: string,
): { status: string } | undefined {
  return db.prepare(`SELECT status FROM sources WHERE id = ?`).get(sourceId) as
    | { status: string }
    | undefined;
}

function documentId(db: Database.Database, sourceId: string): string {
  const row = db
    .prepare(
      `SELECT id FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(sourceId) as { id: string } | undefined;
  if (!row) throw new Error("document-missing");
  return row.id;
}

function pagePassageId(
  db: Database.Database,
  sourceId: string,
  documentId: string,
  page: number,
): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM passages
       WHERE source_id = ? AND document_id = ? AND json_extract(locator_json, '$.page') = ?
       LIMIT 1`,
    )
    .get(sourceId, documentId, page) as { id: string } | undefined;
  return row?.id;
}

function touchSource(db: Database.Database, sourceId: string, status: string, now: number): void {
  db.prepare(`UPDATE sources SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    now,
    sourceId,
  );
}

/**
 * Queue OCR on this machine. Only sources still marked `needs-ocr` may enter the queue. A new run starts at page 1 and gets
 * its own token, so a page still being read for an earlier run (a reloaded window) can tell it no longer owns the row.
 */
export function requestOcr(db: Database.Database, sourceId: string): void {
  const row = sourceStatus(db, sourceId);
  if (!row) throw new Error("source-missing");
  if (row.status !== "needs-ocr") throw new Error("invalid-ocr-state");
  db.transaction(() => {
    touchSource(db, sourceId, "ocr-queued", Date.now());
    setNextPage(db, sourceId, 1);
    db.prepare(
      `UPDATE source_documents SET tree_json = json_set(tree_json, '$.ocrRun', ?)
       WHERE id = (SELECT id FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1)`,
    ).run(uuidv7(), sourceId);
  })();
}

/** The run a queued scan belongs to: the document version it writes into and the token `requestOcr` gave it. */
export type OcrRun = { documentId: string; run: string | null };

/** The run that owns this source right now, or null when it is not queued (or gone). */
export function currentOcrRun(db: Database.Database, sourceId: string): OcrRun | null {
  const row = db
    .prepare(
      `SELECT s.status AS status, d.id AS documentId, json_extract(d.tree_json, '$.ocrRun') AS run
       FROM sources s JOIN source_documents d ON d.source_id = s.id
       WHERE s.id = ? ORDER BY d.version DESC LIMIT 1`,
    )
    .get(sourceId) as { status: string; documentId: string; run: string | null } | undefined;
  return row?.status === "ocr-queued" ? { documentId: row.documentId, run: row.run } : null;
}

/** Whether `mine` is still the run that owns the row. A stopped run, a newer run and a replaced document all say no. */
export function ownsOcrRun(db: Database.Database, sourceId: string, mine: OcrRun): boolean {
  const now = currentOcrRun(db, sourceId);
  return now != null && now.documentId === mine.documentId && now.run === mine.run;
}

/** The page a queued run expects next. Pages go in order from 1, so a scan can only finish after every page was handled. */
function setNextPage(db: Database.Database, sourceId: string, page: number): void {
  db.prepare(
    `UPDATE source_documents SET tree_json = json_set(tree_json, '$.ocrNext', ?)
     WHERE id = (SELECT id FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1)`,
  ).run(page, sourceId);
}

export function nextOcrPage(db: Database.Database, sourceId: string): number {
  const row = db
    .prepare(
      `SELECT json_extract(tree_json, '$.ocrNext') AS next FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(sourceId) as { next: number | null } | undefined;
  return row?.next ?? 1;
}

export function advanceOcr(db: Database.Database, sourceId: string, page: number): void {
  setNextPage(db, sourceId, page + 1);
}

/**
 * Returns a queued scan to `needs-ocr` after a run stopped (cancelled, a failed page, a closed window), so the student can
 * start it again. Pages already read stay, and a new run skips them. Anything not queued (ready, failed, removed, missing)
 * is left alone, so a late stop cannot undo a finished scan. Returns whether a row changed.
 */
export function stopOcr(db: Database.Database, sourceId?: string): number {
  return db
    .prepare(
      `UPDATE sources SET status = 'needs-ocr', updated_at = ? WHERE status = 'ocr-queued' AND (? IS NULL OR id = ?)`,
    )
    .run(Date.now(), sourceId ?? null, sourceId ?? null).changes;
}

/** Whether this page of the latest document already has text from an earlier run. */
export function hasOcrPage(db: Database.Database, sourceId: string, page: number): boolean {
  return pagePassageId(db, sourceId, documentId(db, sourceId), page) != null;
}

/** Store one OCR page as a passage. Skips empty text and pages that already have a passage. */
export function applyOcrPage(db: Database.Database, sourceId: string, page: OcrPage): boolean {
  const row = sourceStatus(db, sourceId);
  if (!row) throw new Error("source-missing");
  if (row.status !== "ocr-queued") throw new Error("ocr-not-active");
  const now = Date.now();
  const document_id = documentId(db, sourceId);
  if (pagePassageId(db, sourceId, document_id, page.page)) return false;
  const version = (
    db.prepare(`SELECT version FROM source_documents WHERE id = ?`).get(document_id) as
      | { version: number }
      | undefined
  )?.version ?? 1;
  const text = page.text.replace(/\s+/g, " ").trim();
  if (!text) return false;
  db.transaction(() => {
    const insert = db.prepare(`INSERT INTO passages
      (id, source_id, document_id, version, text, locator_json, section_path, char_start, char_end, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const chunk of chunkText(text)) {
      insert.run(uuidv7(), sourceId, document_id, version, chunk.text,
        JSON.stringify({ page: page.page }), `p. ${page.page}`, chunk.start, chunk.end, now);
    }
  })();
  return true;
}

/** Mark OCR complete. `ready` when the source has passages, otherwise `failed`. */
export function finishOcr(db: Database.Database, sourceId: string): "ready" | "failed" {
  const row = sourceStatus(db, sourceId);
  if (!row) throw new Error("source-missing");
  if (row.status !== "ocr-queued") throw new Error("ocr-not-active");
  const current = documentId(db, sourceId);
  const count = db
    .prepare(`SELECT COUNT(DISTINCT json_extract(locator_json, '$.page')) AS n FROM passages WHERE source_id = ? AND document_id = ?`)
    .get(sourceId, current) as { n: number };
  const status = count.n > 0 ? "ready" : "failed";
  const now = Date.now();
  touchSource(db, sourceId, status, now);
  db.prepare(`UPDATE source_documents SET tree_json = json_remove(tree_json, '$.ocrNext', '$.ocrRun') WHERE id = ?`).run(current);
  if (status === "ready") {
    db.prepare(
      `UPDATE source_documents SET tree_json = json_set(tree_json, '$.pages', ?) WHERE id = ?`,
    ).run(count.n, documentId(db, sourceId));
  }
  return status;
}

/** Apply plain page text (tests and callers inject OCR output; no bundled recognizer). */
export function runOcr(
  db: Database.Database,
  sourceId: string,
  pages: OcrPage[],
): "ready" | "failed" {
  for (const page of pages) applyOcrPage(db, sourceId, page);
  return finishOcr(db, sourceId);
}
