import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { strFromU8, unzipSync } from "fflate";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { uuidv7 } from "../../shared/ids";
import { putBlob } from "../blobs";

export type ExtractedPage = {
  text: string;
  locator: { page?: number; slide?: number; heading?: string };
  section: string;
};

export type ExtractedDocument = {
  pages: ExtractedPage[];
  /** Most pages have almost no text, so this is a scan. */
  scanned: boolean;
};

const emptyPage = 30;

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedDocument> {
  const doc = await getDocument({
    data: bytes,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  } as Parameters<typeof getDocument>[0]).promise;
  const pages: ExtractedPage[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push({
      text,
      locator: { page: number },
      section: `p. ${number}`,
    });
  }
  await doc.destroy();
  const thin = pages.filter((page) => page.text.length < emptyPage).length;
  return { pages, scanned: pages.length > 0 && thin * 2 > pages.length };
}

export async function extractDocx(bytes: Uint8Array): Promise<ExtractedDocument> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return textSections(result.value, "heading");
}

export function extractPptx(bytes: Uint8Array): ExtractedDocument {
  const entries = unzipSync(bytes);
  const presentation = textOf(entries, "ppt/presentation.xml");
  const rels = textOf(entries, "ppt/_rels/presentation.xml.rels");
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const id = match[1];
    const target = match[2];
    if (id && target) targets.set(id, target);
  }
  const pages: ExtractedPage[] = [];
  let slide = 0;
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
    const id = match[1];
    if (!id) continue;
    slide += 1;
    const target = targets.get(id) ?? "";
    const key = target.replace(/^\//, "").startsWith("ppt/")
      ? target.replace(/^\//, "")
      : `ppt/${target.replace(/^\.\//, "")}`;
    const xml = textOf(entries, key);
    const text = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
      .map((part) => part[1] ?? "")
      .join(" ")
      .trim();
    pages.push({ text, locator: { slide }, section: `slide ${slide}` });
  }
  return { pages, scanned: false };
}

export function extractPlain(text: string, markdown: boolean): ExtractedDocument {
  return textSections(text, markdown ? "heading" : "blank");
}

function textSections(text: string, mode: "heading" | "blank"): ExtractedDocument {
  const chunks =
    mode === "heading"
      ? text.split(/^(?=#{1,3} )/m)
      : text.split(/\n{2,}/);
  const pages = chunks
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const heading = chunk.match(/^#{1,3} (.+)$/m)?.[1];
      return {
        text: chunk,
        locator: { heading },
        section: heading ?? "text",
      };
    });
  return { pages, scanned: false };
}

export async function importDocumentFile(
  db: Database.Database,
  workspace: string,
  filePath: string,
): Promise<{
  sourceId: string;
  title: string;
  chapters: number;
  passages: number;
  exercises: number;
}> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const ext = extname(filePath).toLowerCase();
  const extracted = await extractByExt(bytes, ext);
  const now = Date.now();
  const sourceId = uuidv7(now);
  const documentId = uuidv7(now + 1);
  const title = basename(filePath, ext);
  const sha = putBlob(workspace, bytes, mimeFor(ext), ext.slice(1));
  const status = extracted.scanned ? "needs-ocr" : "ready";
  const kept = extracted.scanned ? [] : extracted.pages.filter((page) => page.text);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sourceId, kindFor(ext), title, sha, mimeFor(ext), status, now, now);
    db.prepare(
      `INSERT INTO source_documents (id, source_id, version, tree_json, created_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(documentId, sourceId, JSON.stringify({ pages: kept.length }), now);
    const insert = db.prepare(
      `INSERT INTO passages
        (id, source_id, document_id, version, text, locator_json, section_path, char_start, char_end, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`,
    );
    kept.forEach((page, index) => {
      insert.run(
        uuidv7(now + index + 2),
        sourceId,
        documentId,
        page.text,
        JSON.stringify(page.locator),
        page.section,
        page.text.length,
        now,
      );
    });
  })();
  return {
    sourceId,
    title,
    chapters: 0,
    passages: kept.length,
    exercises: 0,
  };
}

async function extractByExt(bytes: Uint8Array, ext: string): Promise<ExtractedDocument> {
  if (ext === ".pdf") return extractPdf(bytes);
  if (ext === ".docx") return extractDocx(bytes);
  if (ext === ".pptx") return extractPptx(bytes);
  if (ext === ".md") return extractPlain(new TextDecoder().decode(bytes), true);
  if (ext === ".txt") return extractPlain(new TextDecoder().decode(bytes), false);
  throw new Error("unsupported-file");
}

function mimeFor(ext: string): string {
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".md") return "text/markdown";
  return "text/plain";
}

function kindFor(ext: string): string {
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  return "text";
}

function textOf(entries: Record<string, Uint8Array>, key: string): string {
  const bytes = entries[key];
  return bytes ? strFromU8(bytes) : "";
}

/** A one-page PDF whose only text is `label`. Offsets are computed. */
export function onePagePdf(label: string): Uint8Array {
  const safe = label.replace(/[()\\]/g, "");
  const stream = `BT /F1 18 Tf 20 100 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  return pdfBytes(objects);
}

export function manyPagePdf(count: number, label: string): Uint8Array {
  const safe = label.replace(/[()\\]/g, "");
  const fontId = count + 3;
  const kids = Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${kids}] >>`,
  ];
  for (let page = 1; page <= count; page += 1) {
    const contentId = fontId + page;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= count; page += 1) {
    const stream = `BT /F1 12 Tf 20 100 Td (${safe} ${page}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  return pdfBytes(objects);
}

export function blankPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>",
  ];
  return pdfBytes(objects);
}

function pdfBytes(objects: string[]): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    table += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += table;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}
