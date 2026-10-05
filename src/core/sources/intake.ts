import { statSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { extractPdf, extractPlain, storeExtracted, type StoredSource } from "./documents";
import { fetchSnapshot } from "./link";
import { advanceOcr, applyOcrPage, currentOcrRun, finishOcr, hasOcrPage, nextOcrPage, ownsOcrRun, requestOcr, runOcr, stopOcr } from "./ocr";
import { imageMime, isHeicExt, MAX_HEIC_BYTES } from "./heic";
import { readBoundedSync } from "./bounded-read";
import { ocrBytes, runSourceWorker } from "./worker-client";
import { maxSourceBytes } from "../../shared/source-types";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic", ".heif"]);

export function isImageExt(ext: string): boolean {
  return IMAGE_EXT.has(ext.toLowerCase());
}

export async function importLink(
  db: Database.Database,
  workspace: string,
  url: string,
  fetchImpl?: typeof fetch,
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<StoredSource> {
  const page = await fetchSnapshot(url, fetchImpl, resolve);
  if (page.pdf) {
    const extracted = await extractPdf(page.pdf);
    return storeExtracted(db, workspace, {
      title: page.title || url,
      kind: "pdf",
      mime: "application/pdf",
      ext: "pdf",
      bytes: page.pdf,
      extracted,
      originUrl: page.finalUrl,
      fetchedAt: Date.now(),
    });
  }
  return storeExtracted(db, workspace, {
    title: page.title,
    kind: "link",
    mime: "text/markdown",
    ext: "md",
    bytes: new TextEncoder().encode(page.markdown),
    extracted: extractPlain(page.markdown, true),
    originUrl: page.finalUrl,
    fetchedAt: Date.now(),
  });
}

export async function importImageFile(
  db: Database.Database,
  workspace: string,
  filePath: string,
  recognize: (bytes: Uint8Array) => Promise<string> = (bytes) => ocrBytes(bytes, `${workspace}/runtimes/tesseract`),
  // The decode runs in the extract worker, which reads the file itself, so the HEIC decoder stays off the core thread.
  decodeHeic: (bytes: Uint8Array, path: string) => Promise<{ png: Uint8Array }> = async (_bytes, path) => ({
    png: await runSourceWorker<Uint8Array>("extract-worker", { path, ext: extname(path).toLowerCase(), mode: "pixels" }),
  }),
): Promise<StoredSource> {
  const ext = extname(filePath).toLowerCase();
  if (isHeicExt(ext) && statSync(filePath).size > MAX_HEIC_BYTES) throw new Error("heic-too-large");
  const bytes = readBoundedSync(filePath, maxSourceBytes(ext));
  // Decode first: a corrupt or non-HEIC file is rejected before any source row exists.
  const pixels = isHeicExt(ext) ? (await decodeHeic(bytes, filePath)).png : bytes;
  const stored = storeExtracted(db, workspace, {
    title: basename(filePath, ext),
    kind: "image",
    mime: imageMime(ext),
    ext,
    bytes,
    extracted: { pages: [], scanned: true },
  });
  requestOcr(db, stored.sourceId);
  try {
    const text = (await recognize(pixels)).replace(/\s+/g, " ").trim();
    const status = runOcr(db, stored.sourceId, text ? [{ page: 1, text }] : []);
    return { ...stored, passages: status === "ready" ? 1 : 0 };
  } catch (err) {
    db.prepare(`UPDATE sources SET status = 'failed', updated_at = ? WHERE id = ?`).run(
      Date.now(),
      stored.sourceId,
    );
    throw err;
  }
}

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
  if (row.status === "needs-ocr") {
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
