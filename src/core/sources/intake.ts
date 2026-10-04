import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { extractPdf, extractPlain, storeExtracted, type StoredSource } from "./documents";
import { fetchSnapshot } from "./link";
import { applyOcrPage, finishOcr, requestOcr, runOcr } from "./ocr";
import { heicToPng, imageMime, isHeicExt, MAX_HEIC_BYTES } from "./heic";
import { recognizeImage } from "./recognize";

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
  recognize: (bytes: Uint8Array) => Promise<string> = (bytes) =>
    recognizeImage(bytes, `${workspace}/runtimes/tesseract`),
  decodeHeic: (bytes: Uint8Array) => Promise<{ png: Uint8Array }> = heicToPng,
): Promise<StoredSource> {
  const ext = extname(filePath).toLowerCase();
  if (isHeicExt(ext) && statSync(filePath).size > MAX_HEIC_BYTES) throw new Error("heic-too-large");
  const bytes = new Uint8Array(readFileSync(filePath));
  // Decode first: a corrupt or non-HEIC file is rejected before any source row exists.
  const pixels = isHeicExt(ext) ? (await decodeHeic(bytes)).png : bytes;
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

/** OCR one rendered page. The PNG bytes are the pixels, not a caption. */
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
  if (row.status === "needs-ocr") requestOcr(db, sourceId);
  const text = (await recognize(png)).replace(/\s+/g, " ").trim();
  if (text) applyOcrPage(db, sourceId, { page, text });
  if (!last) return "ocr-queued";
  return finishOcr(db, sourceId);
}
