import type Database from "better-sqlite3";
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

function pagePassageId(db: Database.Database, sourceId: string, page: number): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM passages
       WHERE source_id = ? AND json_extract(locator_json, '$.page') = ?
       LIMIT 1`,
    )
    .get(sourceId, page) as { id: string } | undefined;
  return row?.id;
}

function touchSource(db: Database.Database, sourceId: string, status: string, now: number): void {
  db.prepare(`UPDATE sources SET status = ?, updated_at = ? WHERE id = ?`).run(
    status,
    now,
    sourceId,
  );
}

/** Queue OCR on this machine. Only sources still marked `needs-ocr` may enter the queue. */
export function requestOcr(db: Database.Database, sourceId: string): void {
  const row = sourceStatus(db, sourceId);
  if (!row) throw new Error("source-missing");
  if (row.status !== "needs-ocr") throw new Error("invalid-ocr-state");
  touchSource(db, sourceId, "ocr-queued", Date.now());
}

/** Store one OCR page as a passage. Skips empty text and pages that already have a passage. */
export function applyOcrPage(db: Database.Database, sourceId: string, page: OcrPage): boolean {
  const row = sourceStatus(db, sourceId);
  if (!row) throw new Error("source-missing");
  if (row.status !== "ocr-queued") throw new Error("ocr-not-active");
  if (pagePassageId(db, sourceId, page.page)) return false;
  const text = page.text.replace(/\s+/g, " ").trim();
  if (!text) return false;
  const now = Date.now();
  const document_id = documentId(db, sourceId);
  db.prepare(
    `INSERT INTO passages
      (id, source_id, document_id, version, text, locator_json, section_path, char_start, char_end, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`,
  ).run(
    uuidv7(now),
    sourceId,
    document_id,
    text,
    JSON.stringify({ page: page.page }),
    `p. ${page.page}`,
    text.length,
    now,
  );
  return true;
}

/** Mark OCR complete. `ready` when the source has passages, otherwise `failed`. */
export function finishOcr(db: Database.Database, sourceId: string): "ready" | "failed" {
  const row = sourceStatus(db, sourceId);
  if (!row) throw new Error("source-missing");
  if (row.status !== "ocr-queued") throw new Error("ocr-not-active");
  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`)
    .get(sourceId) as { n: number };
  const status = count.n > 0 ? "ready" : "failed";
  const now = Date.now();
  touchSource(db, sourceId, status, now);
  if (status === "ready") {
    db.prepare(
      `UPDATE source_documents SET tree_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ pages: count.n }), documentId(db, sourceId));
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
