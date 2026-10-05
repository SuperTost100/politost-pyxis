import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { blobParts } from "../shared/blob-path";

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
  if (!file.startsWith(blobsRoot + sep)) throw new Error("path-escape");
  return { file, meta: `${file}.json` };
}

function regularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("blob-unsafe-path");
  return true;
}

function atomicWrite(path: string, bytes: Uint8Array | string): void {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    rmSync(temporary, { force: true });
  }
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
  const sha = createHash("sha256").update(bytes).digest("hex");
  const { file, meta } = location(workspace, sha);
  mkdirSync(join(file, ".."), { recursive: true });
  if (
    !regularFile(file) ||
    createHash("sha256").update(readFileSync(file)).digest("hex") !== sha
  )
    atomicWrite(file, bytes);
  if (!validMetadata(meta)) atomicWrite(meta, JSON.stringify({ mime, ext }));
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

export function readBlob(workspace: string, sha: string): BlobRecord {
  const { file, meta } = location(workspace, sha);
  const parsed = JSON.parse(readFileSync(meta, "utf8")) as { mime?: unknown };
  const mime =
    typeof parsed.mime === "string" ? parsed.mime : "application/octet-stream";
  return { sha, file, mime };
}
