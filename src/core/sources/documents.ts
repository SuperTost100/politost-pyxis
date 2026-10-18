import { createHash } from "node:crypto";
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

/**
 * Reads a PDF's text layer. A PDF locked with a password stops as `pdf-password-required`, or `pdf-password-wrong` when
 * `password` does not open it. The password is only handed to pdf.js for this read.
 */
export async function extractPdf(
  bytes: Uint8Array,
  password?: string,
): Promise<ExtractedDocument> {
  // The modern build loads canvas only for page rendering. Text-only workers must avoid the legacy build's
  // eager native addon load: on Windows its Tokio thread can outlive the DLL when the worker stops.
  const { getDocument, PasswordResponses } = await import("pdfjs-dist");
  const doc = await getDocument({
    data: bytes,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    ...(password ? { password } : {}),
  } as Parameters<typeof getDocument>[0]).promise.catch((error: unknown) => {
    if (error instanceof Error && error.name === "PasswordException")
      throw new Error(
        (error as Error & { code?: number }).code === PasswordResponses.INCORRECT_PASSWORD
          ? "pdf-password-wrong"
          : "pdf-password-required",
      );
    throw error;
  });
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
 * stored archive of this app's own making. Pictures and embedded files are not read: every image becomes an empty
 * element, so mammoth never asks for the missing media.
 *
 * mammoth's HTML keeps Word's Heading 1 to 3 as h1 to h3, which become `#` lines, so each passage names its section
 * as a Markdown file's passages do. Other tags only end a paragraph or are dropped.
 */
export async function extractDocx(
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  const zip = openZip(bytes, OFFICE_ZIP_LIMITS);
  const parts: Record<string, Uint8Array> = {};
  for (const name of zip.names)
    if (/\.(xml|rels)$/i.test(name)) parts[name] = zip.read(name)!;
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(zipSync(parts, { level: 0 })) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  const untag = (html: string) => html.replace(/<[^>]*>/g, "");
  const text = result.value
    .replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
      const heading = untag(inner).replace(/\s+/g, " ").trim();
      return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n\n` : "\n\n";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[4-6]|li|td|th|tr|table|ul|ol|blockquote)>/gi, "\n\n");
  return textSections(decodeXml(untag(text)).replace(/\n{3,}/g, "\n\n"), "heading");
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

/** The text runs of a slide or notes part, in order. */
function runsOf(xml: string): string {
  return [...xml.matchAll(/<a:t[^<>]*>([^<]*)<\/a:t>/g)]
    .map((part) => decodeXml(part[1] ?? ""))
    .join(" ")
    .trim();
}

/** Where a relationship target points, as a path inside the archive. `dir` is the folder of the part that names it. */
function partPath(dir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = dir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** Placeholders on a notes page that are not the speaker's notes: the slide picture, its number, header, footer, date. */
const NOTES_FURNITURE = /<p:ph\b[^<>]*\btype="(?:sldImg|sldNum|hdr|ftr|dt)"/;

/** Marks the speaker notes inside a slide's passage. Section labels in stored passages are English, as `slide 3` is. */
export const SPEAKER_NOTES_LABEL = "Speaker notes:";

/**
 * The speaker notes of the slide stored at `slidePath`, found through the slide's own relationships, or "" when it has
 * none. Only the notes body is read: the slide picture, page number, header, footer and date are skipped.
 */
function slideNotes(entries: BoundedZip, slidePath: string): string {
  const slash = slidePath.lastIndexOf("/");
  const dir = slidePath.slice(0, slash);
  const rels = textOf(entries, `${dir}/_rels/${slidePath.slice(slash + 1)}.rels`);
  for (const tag of rels.matchAll(/<Relationship\b[^<>]*>/g)) {
    if (!/\bType="[^"]*\/notesSlide"/.test(tag[0])) continue;
    const target = /\bTarget="([^"]+)"/.exec(tag[0])?.[1];
    if (!target) continue;
    // Each shape ends at `</p:sp>` and starts at the last `<p:sp` before it. Splitting finds them in one pass, where a
    // lazy pattern would rescan the rest of a hostile part from every unclosed start.
    return textOf(entries, partPath(dir, target))
      .split("</p:sp>")
      .slice(0, -1)
      .map((part) => {
        const start = Math.max(part.lastIndexOf("<p:sp>"), part.lastIndexOf("<p:sp "));
        return start < 0 ? "" : part.slice(start);
      })
      .filter((shape) => shape && !NOTES_FURNITURE.test(shape))
      .map(runsOf)
      .filter(Boolean)
      .join(" ");
  }
  return "";
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
    const shown = runsOf(textOf(entries, key));
    // Lecturers often put the explanation in the notes, so they belong to the slide's passage, marked as notes.
    const notes = slideNotes(entries, key);
    const text = notes
      ? `${shown}${shown ? "\n\n" : ""}${SPEAKER_NOTES_LABEL} ${notes}`
      : shown;
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

/**
 * The original file of a document being stored: its bytes, or the hash it is already stored under. A job passes the
 * hash, so a large file is not read back into core and hashed again.
 */
type Original = { bytes: Uint8Array; sha?: undefined } | { sha: string; bytes?: undefined };

function storeOriginal(workspace: string, original: Original, mime: string, ext: string): string {
  return original.sha !== undefined
    ? original.sha
    : putBlob(workspace, original.bytes, mime, ext.replace(/^\./, ""));
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
    extracted: ExtractedDocument;
    originUrl?: string;
    fetchedAt?: number;
  } & Original,
): StoredSource {
  const now = Date.now();
  const sourceId = input.sourceId ?? uuidv7(now);
  const documentId = uuidv7(now + 1);
  const sha = storeOriginal(workspace, input, input.mime, input.ext);
  const status = input.extracted.scanned ? "needs-ocr" : "ready";
  const kept = keptPages(input.extracted);
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

/**
 * The pages a document keeps. Empty pages carry nothing. In a scan, a page with almost no text (a page number, a stray
 * mark) is left for OCR, and a page with a real text layer is kept: OCR skips a page that already has passages, so a
 * PDF that mixes text and scanned pages keeps its text and has only the scanned pages read.
 */
function keptPages(extracted: ExtractedDocument): ExtractedPage[] {
  return extracted.pages.filter((page) =>
    extracted.scanned ? page.text.trim().length >= emptyPage : page.text.trim(),
  );
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

/**
 * New extraction of an existing source from a new file. Older passages stay for citations. A file with no text at all
 * (a wholly scanned PDF, an empty file) is refused as `replace-no-text` rather than published, as a re-read is: an
 * empty version would hide the text in use until OCR finished. Added as a new source, a scan can be read with OCR.
 */
export function addDocumentVersion(
  db: Database.Database,
  workspace: string,
  sourceId: string,
  input: {
    title: string;
    mime: string;
    ext: string;
    extracted: ExtractedDocument;
  } & Original,
): StoredSource {
  const existing = db
    .prepare(`SELECT id FROM sources WHERE id = ? AND status != 'removed'`)
    .get(sourceId);
  if (!existing) throw new Error("source-missing");
  const kept = keptPages(input.extracted);
  if (kept.length === 0) throw new Error("replace-no-text");
  const sha = storeOriginal(workspace, input, input.mime, input.ext);
  const status = input.extracted.scanned ? "needs-ocr" : "ready";
  const kind = kindFor(input.ext);
  appendVersion(db, sourceId, sha, kind, kept, input.extracted.extractor, (now) => {
    db.prepare(
      // A free book replaced with a document is no longer that book, so it drops the catalog link. Otherwise the books
      // list would offer an update for it that fails. The same goes for a link: a file has no address to check again.
      `UPDATE sources
       SET title = ?, blob_sha = ?, mime = ?, kind = ?, status = ?, catalog_id = NULL, catalog_version = NULL,
           origin_url = NULL, fetched_at = NULL, updated_at = ?
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
 *
 * `snapshot` is a link fetched again: its new copy becomes the source's file in the same transaction, and the old
 * version keeps its own copy, so a citation of the old text still opens the page as it was. The title stays.
 */
export function addExtractionVersion(
  db: Database.Database,
  sourceId: string,
  extracted: ExtractedDocument,
  snapshot?: { sha: string; ext: string; url: string; fetchedAt: number },
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
  // A link import records its snapshot's kind as a document of that type, so a fetched-again one does the same.
  const kind = snapshot ? kindFor(snapshot.ext) : source.kind;
  appendVersion(db, sourceId, snapshot?.sha ?? source.sha, kind, kept, extracted.extractor, (now) => {
    db.prepare(
      `UPDATE sources SET status = 'ready', updated_at = ? WHERE id = ?`,
    ).run(now, sourceId);
    if (snapshot)
      db.prepare(
        `UPDATE sources SET blob_sha = ?, mime = ?, kind = ?, origin_url = ?, fetched_at = ? WHERE id = ?`,
      ).run(
        snapshot.sha,
        mimeFor(snapshot.ext),
        snapshot.ext === ".pdf" ? "pdf" : "link",
        snapshot.url,
        snapshot.fetchedAt,
        sourceId,
      );
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
    title: basename(filePath, extname(filePath)),
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
  /** Opens a locked PDF. Other files ignore it. */
  password?: string,
): Promise<ExtractedDocument> {
  if (ext === ".pdf") return extractPdf(bytes, password);
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

/** The padding string of the PDF standard security handler. */
const PDF_PAD = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const box = Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + box[i]! + key[i % key.length]!) & 255;
    [box[i], box[j]] = [box[j]!, box[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + box[i]!) & 255;
    [box[i], box[j]] = [box[j]!, box[i]!];
    out[n] = data[n]! ^ box[(box[i]! + box[j]!) & 255]!;
  }
  return out;
}

/**
 * A one-page PDF whose only text is `label`, locked with `password` by the standard 40-bit RC4 handler (revision 2),
 * the oldest scheme pdf.js reads. Opening it asks for the password.
 */
export function lockedPdf(label: string, password: string): Uint8Array {
  const md5 = (...parts: Uint8Array[]) => createHash("md5").update(Buffer.concat(parts)).digest();
  const padded = (text: string) => Buffer.concat([Buffer.from(text, "latin1"), PDF_PAD]).subarray(0, 32);
  const id = Buffer.from("7079786973206c6f636b656420706466", "hex");
  const owner = rc4(md5(padded(`${password}-owner`)).subarray(0, 5), padded(password));
  const permissions = Buffer.from([0xfc, 0xff, 0xff, 0xff]);
  const key = md5(padded(password), owner, permissions, id).subarray(0, 5);
  const user = rc4(key, PDF_PAD);
  const safe = label.replace(/[()\\]/g, "");
  // Only the page's content stream holds a string to hide. Its key also mixes in its object number, 4.
  const stream = rc4(
    md5(key, Buffer.from([4, 0, 0, 0, 0])).subarray(0, 10),
    Buffer.from(`BT /F1 12 Tf 20 100 Td (${safe}) Tj ET`, "latin1"),
  ).toString("latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
  ];
  return pdfBytes(objects, `/Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>]`);
}

export function blankPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>",
  ];
  return pdfBytes(objects);
}

/** Builds the file from objects written as Latin-1 text, so binary stream bytes keep their values and offsets. */
function pdfBytes(objects: string[], trailer = ""): Uint8Array {
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
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer ? ` ${trailer}` : ""} >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}
