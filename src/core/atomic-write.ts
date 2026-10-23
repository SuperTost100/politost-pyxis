import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Flushes a folder's entries, so a rename into it survives a power cut. */
export function syncDirectory(path: string): void {
  // Windows does not support opening a directory for fsync. Journal files still sync.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces a file so that a crash or power cut leaves the old contents or the new ones, never a part: the bytes go to a
 * private temporary file beside it, are flushed, renamed over the file, and the folder is flushed. The temporary file
 * is removed if any step fails. Readable by the owner only.
 */
export function writeFileAtomic(path: string, data: Uint8Array | string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}
