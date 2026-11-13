import { readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import type Database from "better-sqlite3";
import { blobSize, readBlob } from "../blobs";
import { latestDocument } from "./documents";
import { linkedFile, readableLinkedPath } from "./linked-file";
import { readingOrder } from "./smartbook";

/** The most one `sources.readOriginal` call returns. pdf.js asks for 64 KiB chunks; an image comes in a few calls. */
export const ORIGINAL_CHUNK_MAX = 2 * 1024 * 1024;

const READING = new Set(["queued", "extracting", "indexing", "ocr-queued"]);
const LOCKED = new Set(["pdf-password-required", "pdf-password-wrong"]);

/** The type of file each extension is, for a linked file, whose type no stored metadata keeps. */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

type Row = {
  id: string;
  title: string;
  kind: string;
  status: string;
  blob_sha: string | null;
  mime: string | null;
  origin_url: string | null;
  document_id: string | null;
  tree_json: string | null;
  version: number | null;
  latest: number | null;
};

type Located = {
  row: Row;
  /** The cited version's type of file: a replacement can change it, and each version's tree records its own. */
  kind: string;
  /** The stored original of the cited version, or of the current one. */
  sha: string | null;
  /** The passage's document is the source's latest. A source opened without a passage always is. */
  current: boolean;
};

/** The source a request names, with the document the citation was read from (the latest one without a passage). */
function locate(db: Database.Database, input: { sourceId?: string; passageId?: string }): Located | null {
  const row = db
    .prepare(
      `SELECT s.id, s.title, s.kind, s.status, s.blob_sha, s.mime, s.origin_url, d.id AS document_id, d.tree_json,
         d.version, (SELECT MAX(version) FROM source_documents WHERE source_id = s.id) AS latest
       FROM sources s LEFT JOIN source_documents d ON d.id = COALESCE(
         (SELECT document_id FROM passages WHERE id = ?), ${latestDocument("s.id")})
       WHERE s.id = COALESCE((SELECT source_id FROM passages WHERE id = ?), ?)`,
    )
    .get(input.passageId ?? null, input.passageId ?? null, input.sourceId ?? null) as Row | undefined;
  if (!row) return null;
  const tree = row.tree_json ? (JSON.parse(row.tree_json) as { blobSha?: unknown; kind?: unknown }) : {};
  const current = row.version == null || row.version === row.latest;
  // An older version keeps its own original and kind in its tree; the source's columns hold the current one's.
  const sha = typeof tree.blobSha === "string" ? tree.blobSha : current ? row.blob_sha : null;
  const kind = typeof tree.kind === "string" ? tree.kind : row.kind;
  return { row, kind, sha, current };
}

/** Where the bytes of the original are now: the stored copy, the linked file read in place, or nowhere. */
function originalPath(db: Database.Database, workspace: string, at: Located): { path: string; mime: string } | null {
  if (at.sha && blobSize(workspace, at.sha) !== null) {
    const blob = readBlob(workspace, at.sha);
    // The source's column describes its current file. An older version's copy has its type in the blob's own record.
    return { path: blob.file, mime: (at.current ? at.row.mime : null) ?? blob.mime };
  }
  if (!linkedFile(db, at.row.id)) return null;
  try {
    const path = readableLinkedPath(db, at.row.id);
    return { path, mime: MIME_BY_EXT[extname(path).toLowerCase()] ?? at.row.mime ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

export type PanelSource = ReturnType<typeof panelSource>;

/**
 * What the source panel needs to decide what to draw: the file, whether its original can be read now and from where,
 * where the read is, and the cited passage. Reads only what is stored and one `stat`; nothing is opened or decoded.
 */
export function panelSource(db: Database.Database, workspace: string, input: { sourceId?: string; passageId?: string }) {
  const at = locate(db, input);
  if (!at) return null;
  const { row } = at;
  const linked = linkedFile(db, row.id);
  const original = originalPath(db, workspace, at);
  const size = original ? fileSize(original.path) : null;
  const failure =
    row.status === "failed"
      ? (db
          .prepare(
            `SELECT id, error FROM jobs WHERE kind IN ('source-import', 'source-import-vision') AND state = 'failed'
             AND error IS NOT NULL AND json_extract(params_json, '$.sourceId') = ? ORDER BY created_at DESC LIMIT 1`,
          )
          .get(row.id) as { id: string; error: string } | undefined)
      : undefined;
  const state =
    row.status === "removed"
      ? ("removed" as const)
      : failure && LOCKED.has(failure.error)
        ? ("locked" as const)
        : READING.has(row.status)
          ? ("reading" as const)
          : row.status === "failed" || row.status === "cancelled" || row.status === "interrupted"
            ? ("failed" as const)
            : ("ready" as const);
  const passage = input.passageId
    ? (db.prepare(`SELECT id, text, section_path, locator_json FROM passages WHERE id = ?`).get(input.passageId) as
        | { id: string; text: string; section_path: string | null; locator_json: string | null }
        | undefined)
    : undefined;
  const locator = passage?.locator_json ? (JSON.parse(passage.locator_json) as Record<string, unknown>) : {};
  // Pages and slides the read found in this version, the length a scan or a deck is paged by when nothing draws it.
  const counts = at.row.document_id
    ? (db
        .prepare(
          `SELECT MAX(json_extract(locator_json, '$.page')) AS pages, MAX(json_extract(locator_json, '$.slide')) AS slides
           FROM passages WHERE document_id = ?`,
        )
        .get(at.row.document_id) as { pages: number | null; slides: number | null })
    : { pages: null, slides: null };
  return {
    sourceId: row.id,
    title: row.title,
    kind: at.kind,
    status: row.status,
    state,
    /** The job a locked PDF stopped, which takes the password. */
    errorJobId: state === "locked" ? (failure?.id ?? null) : null,
    /** `stored` for the copy Pyxis keeps, `linked` for the student's file read in place, null when neither is readable. */
    original: original ? (isStored(workspace, at, original.path) ? ("stored" as const) : ("linked" as const)) : null,
    mime: original?.mime ?? (at.current ? row.mime : null),
    size,
    /** The file lives in a linked folder and is read in place; otherwise Pyxis keeps a copy of it. */
    linked: linked !== null,
    /** The original can't be read: a linked file moved, renamed or deleted, or a stored copy that is gone. */
    missing: linked?.missing === true || (!original && (Boolean(at.sha) || linked !== null)),
    /** The citation comes from an older version than the file now holds, so its page may have moved or gone. */
    changed: !at.current,
    originUrl: row.origin_url,
    pages: counts.pages,
    slides: counts.slides,
    passage: passage
      ? {
          id: passage.id,
          text: passage.text,
          sectionPath: passage.section_path,
          page: typeof locator["page"] === "number" ? locator["page"] : null,
          slide: typeof locator["slide"] === "number" ? locator["slide"] : null,
          chapter: typeof locator["chapter"] === "number" ? locator["chapter"] : null,
        }
      : null,
  };
}

function fileSize(path: string): number | null {
  return statSync(path, { throwIfNoEntry: false })?.size ?? null;
}

function isStored(workspace: string, at: Located, path: string): boolean {
  return at.sha !== null && path === readBlob(workspace, at.sha).file;
}

/**
 * The passages one page or slide of the cited version holds (the latest version without a passage), in reading order:
 * the text a scan or a photo was read as, or a slide's words.
 */
export function panelPage(
  db: Database.Database,
  input: { sourceId?: string; passageId?: string; unit: "page" | "slide"; n: number },
) {
  const at = locate(db, input);
  if (!at?.row.document_id) return [];
  const rows = db
    .prepare(
      `SELECT id, text, section_path FROM passages WHERE document_id = ? AND json_extract(locator_json, '$.${input.unit}') = ?
       ORDER BY ${readingOrder()}`,
    )
    .all(at.row.document_id, input.n) as Array<{ id: string; text: string; section_path: string | null }>;
  return rows.map((row) => ({ id: row.id, text: row.text, sectionPath: row.section_path, current: row.id === input.passageId }));
}

/**
 * `length` bytes of the original from `start`: of the cited version's stored copy, or of the linked file read in place
 * now. The source is named by id, so the window never chooses a path. Errors: `source-file-missing`.
 */
export async function readOriginal(
  db: Database.Database,
  workspace: string,
  input: { sourceId?: string; passageId?: string; start: number; length: number },
): Promise<{ bytes: Uint8Array; size: number }> {
  const at = locate(db, input);
  const original = at && at.row.status !== "removed" ? originalPath(db, workspace, at) : null;
  if (!original) throw new Error("source-file-missing");
  const file = await open(original.path, "r");
  try {
    const size = (await file.stat()).size;
    const start = Math.min(input.start, size);
    const length = Math.max(0, Math.min(input.length, ORIGINAL_CHUNK_MAX, size - start));
    const bytes = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(bytes, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { bytes: read === length ? bytes : bytes.subarray(0, read), size };
  } finally {
    await file.close();
  }
}

/**
 * The file "Apri il file" hands to the system: the stored copy (main gives it the file's name first) or the linked file,
 * for a source still in the Library. Null for anything else.
 */
export function fileToOpen(
  db: Database.Database,
  workspace: string,
  sourceId: string,
): { path: string; name: string; stored: boolean } | null {
  const at = locate(db, { sourceId });
  if (!at || at.row.status === "removed") return null;
  const original = originalPath(db, workspace, at);
  if (!original) return null;
  const stored = isStored(workspace, at, original.path);
  const ext = stored ? storedExt(workspace, at.sha!) : extname(original.path);
  const base = at.row.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Pyxis";
  return { path: original.path, name: ext && !base.toLowerCase().endsWith(ext.toLowerCase()) ? `${base}${ext}` : base, stored };
}

function storedExt(workspace: string, sha: string): string {
  try {
    const meta = JSON.parse(readFileSync(`${readBlob(workspace, sha).file}.json`, "utf8")) as { ext?: unknown };
    return typeof meta.ext === "string" && /^[a-z0-9]{1,8}$/i.test(meta.ext) ? `.${meta.ext}` : "";
  } catch {
    return "";
  }
}
