import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  statSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
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
  { table: "held_files", sha: "blob_sha" },
  { table: "held_files", sha: "extracted_sha" },
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

/**
 * The file operations a blob uses, in one place so a test can make the system behave as Windows does while a file is
 * deleted under an open handle: the name stays in the folder but cannot be opened, read or replaced until the handle goes.
 */
export const blobFs = {
  exists: existsSync,
  lstat: lstatSync,
  read: readFileSync,
  rm: rmSync,
  rename: renameSync,
  write: writeFileAtomic,
};

function regularFile(path: string): boolean {
  if (!blobFs.exists(path)) return false;
  const info = blobFs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("blob-unsafe-path");
  return true;
}

function validMetadata(path: string): boolean {
  if (!regularFile(path)) return false;
  try {
    const meta = JSON.parse(blobFs.read(path, "utf8") as string) as {
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
    sha256(blobFs.read(file)) !== sha
  )
    blobFs.write(file, bytes);
  if (!validMetadata(meta)) blobFs.write(meta, JSON.stringify({ mime, ext }));
  return sha;
}

/** Whether the stored file for this hash is there now, so a caller can tell which blobs its own write made new. */
export function hasBlob(workspace: string, sha: string): boolean {
  return regularFile(location(workspace, sha).file);
}

/**
 * Takes one file off its name: it is renamed to a temporary name, which is what a write's leftover looks like (a backup
 * skips it and Free up space removes it), and the file under that name is deleted. The blob's own name is free at once.
 * On Windows a file something still holds open is not deleted but marked for deletion: its name stays in the folder and
 * cannot be opened or replaced until the last handle closes, so a blob deleted under its own name could not be stored
 * again in that time. A file the system will not rename stays whole under its name, and the error is the caller's.
 */
function takeOff(path: string): void {
  const gone = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    blobFs.rename(path, gone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    blobFs.rm(gone, { force: true });
  } catch {
    /* Ceiling: the temporary name stays until Free up space or the next run. */
  }
}

/**
 * Removes a blob and its metadata. Only for a blob this caller has just made new and no row references, to undo its own
 * write, or for one nothing references any more. A blob that was already there, or may be shared, is never removed. The
 * blob is off its name at once, so storing the same bytes again never meets a file on its way out (see `takeOff`).
 */
export function removeBlob(workspace: string, sha: string): void {
  const { file, meta } = location(workspace, sha);
  takeOff(file);
  takeOff(meta);
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
