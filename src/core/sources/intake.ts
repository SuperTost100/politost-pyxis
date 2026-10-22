import type Database from "better-sqlite3";
import { advanceOcr, applyOcrPage, canStartOcr, currentOcrRun, finishOcr, hasOcrPage, nextOcrPage, ownsOcrRun, requestOcr, stopOcr } from "./ocr";

/**
 * OCR one rendered page. The PNG bytes are the pixels, not a caption. Pages arrive in order from 1 and the scan finishes
 * on `last`, so it cannot become `ready` with a page missing. Only page 1 can start a run, and a refused page changes
 * nothing. A page that already has text from an earlier run is not read again. If a page fails or is cancelled, the scan
 * goes back to `needs-ocr` with its pages kept, and the error is rethrown.
 *
 * The read takes a while, and the window that asked may reload and start a new run meanwhile. The run is identified when the
 * page arrives and checked again once the text is back, before anything is written. A page that finds a different run, a
 * stopped scan or a replaced document throws `ocr-stale` and touches nothing, and neither it nor a read that fails late
 * stops the run that replaced it.
 */
export async function ocrPngPage(
  db: Database.Database,
  sourceId: string,
  page: number,
  png: Uint8Array,
  recognize: (bytes: Uint8Array) => Promise<string>,
  last: boolean,
): Promise<"ready" | "failed" | "ocr-queued"> {
  const row = db.prepare(`SELECT status FROM sources WHERE id = ?`).get(sourceId) as
    | { status: string }
    | undefined;
  if (!row) throw new Error("source-missing");
  if (row.status !== "ocr-queued" && canStartOcr(db, sourceId, row.status)) {
    if (page !== 1) throw new Error("ocr-out-of-order");
    requestOcr(db, sourceId);
  } else if (row.status !== "ocr-queued") throw new Error("ocr-not-active");
  else if (page !== nextOcrPage(db, sourceId)) throw new Error("ocr-out-of-order");
  const mine = currentOcrRun(db, sourceId)!;
  try {
    if (!hasOcrPage(db, sourceId, page)) {
      const text = (await recognize(png)).replace(/\s+/g, " ").trim();
      if (!ownsOcrRun(db, sourceId, mine) || nextOcrPage(db, sourceId) !== page) throw new Error("ocr-stale");
      if (text) applyOcrPage(db, sourceId, { page, text });
    }
    advanceOcr(db, sourceId, page);
    if (!last) return "ocr-queued";
    return finishOcr(db, sourceId);
  } catch (err) {
    if (!(err instanceof Error && err.message === "ocr-stale") && ownsOcrRun(db, sourceId, mine)) stopOcr(db, sourceId);
    throw err;
  }
}
