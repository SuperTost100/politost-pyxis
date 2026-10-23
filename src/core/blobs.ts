import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { strictlyInside } from "./path-inside";
import type Database from "better-sqlite3";
import { blobParts } from "../shared/blob-path";
import { writeFileAtomic } from "./atomic-write";
import { sha256 } from "./sources/quality";

/**
 * Every place a row names a stored file: the table, and the SQL that reads the hash from one of its rows. Backup copies
 * the files these name and deleting a chat or plan keeps them, so a place missing here loses the file.
 */
export const BLOB_REFERENCES = [
  { table: "sources", sha: "blob_sha" },
  { table: "attachments", sha: "blob_sha" },
  { table: "whiteboards", sha: "blob_sha" },
  { table: "source_documents", sha: "json_extract(tree_json, '$.blobSha')" },
  { table: "source_documents", sha: "json_extract(tree_json, '$.sourceSha')" },
] as const;

const SHA = /^[a-f0-9]{64}$/;

/** Every blob hash a row names now. */
export function namedBlobs(db: Database.Database): Set<string> {
  const rows = db
    .prepare(BLOB_REFERENCES.map((place) => `SELECT ${place.sha} AS sha FROM ${place.table}`).join(" UNION "))
    .all() as Array<{ sha: unknown }>;
  return new Set(
    rows.flatMap((row) => (typeof row.sha === "string" && SHA.test(row.sha) ? [row.sha] : [])),
  );
}

/** Whether any row names this blob hash now. */
export function blobNamed(db: Database.Database, sha: string): boolean {
  return (
    db
      .prepare(
        `${BLOB_REFERENCES.map((place) => `SELECT 1 FROM ${place.table} WHERE ${place.sha} = ?`).join(" UNION ALL ")}
         LIMIT 1`,
      )
      .get(...BLOB_REFERENCES.map(() => sha)) !== undefined
  );
}

export type BlobRecord = {
  sha: string;
  file: string;
  mime: string;
};

function location(
  workspace: string,
  sha: string,
): { file: string; meta: string } {
  const [folder, dir, name] = blobParts(sha);
  const blobsRoot = join(workspace, folder);
  const file = join(blobsRoot, dir, name);
  if (!strictlyInside(blobsRoot, file)) throw new Error("path-escape");
  return { file, meta: `${file}.json` };
}

function regularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("blob-unsafe-path");
  return true;
}

function validMetadata(path: string): boolean {
  if (!regularFile(path)) return false;
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as {
      mime?: unknown;
      ext?: unknown;
    };
    return (
      !!meta &&
      !Array.isArray(meta) &&
      typeof meta.mime === "string" &&
      /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(meta.mime) &&
      meta.mime.length <= 200 &&
      typeof meta.ext === "string" &&
      /^[a-zA-Z0-9.]{0,32}$/.test(meta.ext)
    );
  } catch {
    return false;
  }
}

export function putBlob(
  workspace: string,
  bytes: Uint8Array,
  mime: string,
  ext: string,
): string {
  const sha = sha256(bytes);
  const { file, meta } = location(workspace, sha);
  mkdirSync(join(file, ".."), { recursive: true });
  if (
    !regularFile(file) ||
    sha256(readFileSync(file)) !== sha
  )
    writeFileAtomic(file, bytes);
  if (!validMetadata(meta)) writeFileAtomic(meta, JSON.stringify({ mime, ext }));
  return sha;
}

/** Whether the stored file for this hash is there now, so a caller can tell which blobs its own write made new. */
export function hasBlob(workspace: string, sha: string): boolean {
  return regularFile(location(workspace, sha).file);
}

/**
 * Removes a blob and its metadata. Only for a blob this caller has just made new and no row references, to undo its own
 * write. A blob that was already there, or may be shared, is never removed.
 */
export function removeBlob(workspace: string, sha: string): void {
  const { file, meta } = location(workspace, sha);
  rmSync(file, { force: true });
  rmSync(meta, { force: true });
}

/** The stored file's size in bytes, or null when it is missing. Reads no metadata, for listing many at once. */
export function blobSize(workspace: string, sha: string): number | null {
  const info = statSync(location(workspace, sha).file, { throwIfNoEntry: false });
  return info?.isFile() ? info.size : null;
}

export function readBlob(workspace: string, sha: string): BlobRecord {
  const { file, meta } = location(workspace, sha);
  const parsed = JSON.parse(readFileSync(meta, "utf8")) as { mime?: unknown };
  const mime =
    typeof parsed.mime === "string" ? parsed.mime : "application/octet-stream";
  return { sha, file, mime };
}
