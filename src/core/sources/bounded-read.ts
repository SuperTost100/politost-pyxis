import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Whole-file reads for files a student picked, which another process can still write to. The size is taken from the
 * open handle and checked against the cap before any buffer exists, and the buffer is that size plus one byte. A file
 * that grows after the check fills the spare byte and is refused (`source-changed`), so memory never exceeds the cap
 * however big the file becomes. A file that shrinks returns what is left. Errors: `source-too-big`, `source-unreadable`
 * (not a regular file), `source-changed`.
 */
function check(info: { size: number; isFile(): boolean }, maxBytes: number): number {
  if (!info.isFile()) throw new Error("source-unreadable");
  if (info.size > maxBytes) throw new Error("source-too-big");
  return info.size;
}

export async function readBounded(path: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const size = check(await handle.stat(), maxBytes);
    const buffer = Buffer.allocUnsafe(size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > size) throw new Error("source-changed");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
  } finally {
    await handle.close();
  }
}

export function readBoundedSync(path: string, maxBytes: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const size = check(fstatSync(fd), maxBytes);
    const buffer = Buffer.allocUnsafe(size + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const bytesRead = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > size) throw new Error("source-changed");
    return new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
  } finally {
    closeSync(fd);
  }
}
