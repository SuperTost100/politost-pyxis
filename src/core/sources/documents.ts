import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { strFromU8, zipSync } from "fflate";
import mammoth from "mammoth";
import { chunkText } from "./chunk";
import { uuidv7 } from "../../shared/ids";
import { putBlob } from "../blobs";
import { openZip, type BoundedZip, type ZipLimits } from "./zip-bounded";

export type ExtractedPage = {
  text: string;
  locator: { page?: number; slide?: number; heading?: string };
  section: string;
};

/** Which path read an image. Stored with the document so the library can say so. */
export type Extractor =
  | {
      path: "vision";
      provider: string;
      model: string;
      prompt?: { template: string; version: string };
      /** The copy the model saw. The stored original is untouched, and `resizedFrom` says what it was cut down from. */
      sent?: {
        mediaType: string;
        bytes: number;
        width?: number;
        height?: number;
        resizedFrom?: { width: number; height: number; bytes: number };
        /** The EXIF orientation applied to the copy, when it was not upright. */
        orientation?: number;
      };
    }
  | { path: "ocr"; after?: "vision-failed" | "vision-too-large" };

export type ExtractedDocument = {
  pages: ExtractedPage[];
  extractor?: Extractor;
  /** Most pages have almost no text, so this is a scan. */
  scanned: boolean;
};

const emptyPage = 30;

export async function extractPdf(
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  // The modern build loads canvas only for page rendering. Text-only workers must avoid the legacy build's
  // eager native addon load: on Windows its Tokio thread can outlive the DLL when the worker stops.
  const { getDocument } = await import("pdfjs-dist");
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

/**
 * What a .docx or .pptx may inflate to. Both are XML text, so these are far above any real file and far below what
 * would exhaust the worker. A document that passes them is refused as `archive-too-large`, however small the file is.
 */
export const OFFICE_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
};

/**
 * mammoth reads the archive with its own unbounded inflater, so it is never given the original. Only the XML parts
 * (and relationship files) are read through the bounded reader, with their real output counted, and handed on as a
 * stored archive of this app's own making. Pictures and embedded files are not read, since raw text has none.
 */
export async function extractDocx(
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  const zip = openZip(bytes, OFFICE_ZIP_LIMITS);
  const parts: Record<string, Uint8Array> = {};
  for (const name of zip.names)
    if (/\.(xml|rels)$/i.test(name)) parts[name] = zip.read(name)!;
  const result = await mammoth.extractRawText({
    buffer: Buffer.from(zipSync(parts, { level: 0 })),
  });
  return textSections(result.value, "heading");
}

function decodeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, value: string) =>
      String.fromCodePoint(parseInt(value, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function extractPptx(bytes: Uint8Array): ExtractedDocument {
  const entries = openZip(bytes, OFFICE_ZIP_LIMITS);
  const presentation = textOf(entries, "ppt/presentation.xml");
  const rels = textOf(entries, "ppt/_rels/presentation.xml.rels");
  const targets = new Map<string, string>();
  for (const tag of rels.matchAll(/<Relationship\b[^<>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(tag[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag[0])?.[1];
    if (id && target) targets.set(id, target);
  }
  const pages: ExtractedPage[] = [];
  let slide = 0;
  for (const match of presentation.matchAll(/<p:sldId\b[^<>]*r:id="([^"<>]+)"/g)) {
    const id = match[1];
    if (!id) continue;
    slide += 1;
    const target = targets.get(id) ?? "";
    const key = target.replace(/^\//, "").startsWith("ppt/")
      ? target.replace(/^\//, "")
      : `ppt/${target.replace(/^\.\//, "")}`;
    const xml = textOf(entries, key);
    const text = [...xml.matchAll(/<a:t[^<>]*>([^<]*)<\/a:t>/g)]
      .map((part) => decodeXml(part[1] ?? ""))
      .join(" ")
      .trim();
    pages.push({ text, locator: { slide }, section: `slide ${slide}` });
  }
  return { pages, scanned: false };
}

export function extractPlain(
  text: string,
  markdown: boolean,
): ExtractedDocument {
  return textSections(text, markdown ? "heading" : "blank");
}

function textSections(
  text: string,
  mode: "heading" | "blank",
): ExtractedDocument {
  const chunks =
    mode === "heading" ? text.split(/^(?=#{1,3} )/m) : text.split(/\n{2,}/);
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

export type StoredSource = {
  sourceId: string;
  title: string;
  chapters: number;
  passages: number;
  exercises: number;
};

export function storeExtracted(
  db: Database.Database,
  workspace: string,
  input: {
    sourceId?: string;
    title: string;
    kind: string;
    mime: string;
    ext: string;
    bytes: Uint8Array;
    extracted: ExtractedDocument;
    originUrl?: string;
    fetchedAt?: number;
  },
): StoredSource {
  const now = Date.now();
  const sourceId = input.sourceId ?? uuidv7(now);
  const documentId = uuidv7(now + 1);
  const sha = putBlob(
    workspace,
    input.bytes,
    input.mime,
    input.ext.replace(/^\./, ""),
  );
  const status = input.extracted.scanned ? "needs-ocr" : "ready";
  const kept = input.extracted.scanned
    ? []
    : input.extracted.pages.filter((page) => page.text);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO sources
        (id, kind, title, blob_sha, mime, status, origin_url, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, blob_sha = excluded.blob_sha, mime = excluded.mime, status = excluded.status, updated_at = excluded.updated_at`,
    ).run(
      sourceId,
      input.kind,
      input.title,
      sha,
      input.mime,
      status,
      input.originUrl ?? null,
      input.fetchedAt ?? null,
      now,
      now,
    );
    insertPages(
      db,
      sourceId,
      documentId,
      1,
      kept,
      now,
      sha,
      input.kind,
      input.extracted.extractor,
    );
  })();
  return {
    sourceId,
    title: input.title,
    chapters: 0,
    passages: kept.length,
    exercises: 0,
  };
}

function insertPages(
  db: Database.Database,
  sourceId: string,
  documentId: string,
  version: number,
  pages: ExtractedPage[],
  now: number,
  blobSha: string,
  kind: string,
  extractor?: Extractor,
): void {
  db.prepare(
    `INSERT INTO source_documents (id, source_id, version, tree_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    sourceId,
    version,
    JSON.stringify({
      pages: pages.length,
      blobSha,
      kind,
      ...(extractor ? { extractor } : {}),
    }),
    now,
  );
  const insert = db.prepare(
    `INSERT INTO passages
      (id, source_id, document_id, version, text, locator_json, section_path, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let index = 0;
  for (const page of pages) {
    for (const chunk of chunkText(page.text)) {
      insert.run(
        uuidv7(now + index + 2),
        sourceId,
        documentId,
        version,
        chunk.text,
        JSON.stringify(page.locator),
        page.section,
        chunk.start,
        chunk.end,
        now,
      );
      index += 1;
    }
  }
}

/** The pages a document keeps: a scan has no text layer yet, and empty pages carry nothing. */
function keptPages(extracted: ExtractedDocument): ExtractedPage[] {
  return extracted.scanned ? [] : extracted.pages.filter((page) => page.text.trim());
}

/**
 * Publishes `pages` as the next extraction version of a source and marks every item that cites an older version
 * stale. Older passages stay for citations. `updateSource` writes the source row in the same transaction.
 */
function appendVersion(
  db: Database.Database,
  sourceId: string,
  sha: string,
  kind: string,
  pages: ExtractedPage[],
  extractor: Extractor | undefined,
  updateSource: (now: number) => void,
): void {
  const now = Date.now();
  const documentId = uuidv7(now);
  const { n } = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS n FROM source_documents WHERE source_id = ?`,
    )
    .get(sourceId) as { n: number };
  db.transaction(() => {
    insertPages(db, sourceId, documentId, n + 1, pages, now, sha, kind, extractor);
    db.prepare(
      `UPDATE item_passages SET stale = 1
       WHERE passage_id IN (
         SELECT id FROM passages WHERE source_id = ? AND document_id != ?
       )`,
    ).run(sourceId, documentId);
    updateSource(now);
  })();
}

/** New extraction of an existing source from a new file. Older passages stay for citations. */
export function addDocumentVersion(
  db: Database.Database,
  workspace: string,
  sourceId: string,
  input: {
    title: string;
    mime: string;
    ext: string;
    bytes: Uint8Array;
    extracted: ExtractedDocument;
  },
): StoredSource {
  const existing = db
    .prepare(`SELECT id FROM sources WHERE id = ? AND status != 'removed'`)
    .get(sourceId);
  if (!existing) throw new Error("source-missing");
  const sha = putBlob(
    workspace,
    input.bytes,
    input.mime,
    input.ext.replace(/^\./, ""),
  );
  const status = input.extracted.scanned ? "needs-ocr" : "ready";
  const kept = keptPages(input.extracted);
  const kind = kindFor(input.ext);
  appendVersion(db, sourceId, sha, kind, kept, input.extracted.extractor, (now) => {
    db.prepare(
      `UPDATE sources
       SET title = ?, blob_sha = ?, mime = ?, kind = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(input.title, sha, input.mime, kind, status, now, sourceId);
  });
  return {
    sourceId,
    title: input.title,
    chapters: 0,
    passages: kept.length,
    exercises: 0,
  };
}

/**
 * A new extraction of the stored original, for a source that is read again. The file, its name and its type stay
 * as they are, and only the passages are new, so items that cite the old text keep it (marked stale) until they
 * are regenerated. A run that finds no text is refused rather than published: it would leave the source empty
 * where the old reading had text. Errors: `source-missing`, `reextract-unavailable` (no stored file), `reextract-no-text`.
 */
export function addExtractionVersion(
  db: Database.Database,
  sourceId: string,
  extracted: ExtractedDocument,
): StoredSource {
  const source = db
    .prepare(
      `SELECT title, kind, blob_sha AS sha FROM sources WHERE id = ? AND status != 'removed'`,
    )
    .get(sourceId) as { title: string; kind: string; sha: string | null } | undefined;
  if (!source) throw new Error("source-missing");
  if (!source.sha) throw new Error("reextract-unavailable");
  const kept = keptPages(extracted);
  if (kept.length === 0) throw new Error("reextract-no-text");
  appendVersion(db, sourceId, source.sha, source.kind, kept, extracted.extractor, (now) => {
    db.prepare(
      `UPDATE sources SET status = 'ready', updated_at = ? WHERE id = ?`,
    ).run(now, sourceId);
  });
  return {
    sourceId,
    title: source.title,
    chapters: 0,
    passages: kept.length,
    exercises: 0,
  };
}

export async function importDocumentFile(
  db: Database.Database,
  workspace: string,
  filePath: string,
): Promise<StoredSource> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const ext = extname(filePath).toLowerCase();
  const extracted = await extractByExt(bytes, ext);
  return storeExtracted(db, workspace, {
    title: basename(filePath, ext),
    kind: kindFor(ext),
    mime: mimeFor(ext),
    ext,
    bytes,
    extracted,
  });
}

export async function extractByExt(
  bytes: Uint8Array,
  ext: string,
): Promise<ExtractedDocument> {
  if (ext === ".pdf") return extractPdf(bytes);
  if (ext === ".docx") return extractDocx(bytes);
  if (ext === ".pptx") return extractPptx(bytes);
  if (ext === ".md") return extractPlain(new TextDecoder().decode(bytes), true);
  if (ext === ".txt")
    return extractPlain(new TextDecoder().decode(bytes), false);
  throw new Error("unsupported-file");
}

export function mimeFor(ext: string): string {
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (ext === ".md") return "text/markdown";
  return "text/plain";
}

export function kindFor(ext: string): string {
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".pptx") return "pptx";
  return "text";
}

function textOf(entries: BoundedZip, key: string): string {
  const bytes = entries.read(key);
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
  const kids = Array.from(
    { length: count },
    (_, index) => `${index + 3} 0 R`,
  ).join(" ");
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
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
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
