import { createHash } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { gunzipSync, inflateRawSync } from "node:zlib";

// Block-level differential downloads, adapted from electron-updater's differential downloader (MIT, Copyright (c) 2015
// Loopline Systems; see docs/notices.md). electron-builder cuts an installer into content-defined blocks and lists each
// block's checksum and size in a blockmap. Blocks the old file already has are copied from it; only the others are
// downloaded, one HTTP Range request per run of changed blocks. The rebuilt file still has to match SHA256SUMS.

/** The largest blockmap Pyxis reads, compressed and unpacked. A 330 MB zip has a 323 KB blockmap (2026-10). */
export const MAX_BLOCKMAP_BYTES = 8 * 1024 * 1024;
const MAX_BLOCKMAP_JSON = 64 * 1024 * 1024;
const COPY_CHUNK = 1024 * 1024;

export type BlockMapFile = {
  name: string;
  offset: number;
  checksums: string[];
  sizes: number[];
};
export type BlockMap = { version: string; files: BlockMapFile[] };
/** A byte range of the new file: copied from `[start, end)` of the old file, or downloaded from `[start, end)`. */
export type Operation = {
  kind: "copy" | "download";
  start: number;
  end: number;
};

/**
 * Why a differential download was not used. Every one of these falls back to downloading the whole file.
 * - `blockmap`: a blockmap is missing, too large or not one Pyxis can read.
 * - `plan`: the two blockmaps don't describe files Pyxis can rebuild one from the other.
 * - `range`: the server ignored the Range header or answered with other bytes.
 * - `mismatch`: the rebuilt file's size or SHA-256 differs from the release's.
 */
export class DiffError extends Error {
  constructor(readonly reason: "blockmap" | "plan" | "range" | "mismatch") {
    super(`update-diff-${reason}`);
  }
}

const count = (value: unknown, min: number) =>
  Number.isSafeInteger(value) && (value as number) >= min;

/** Checks the shape of a blockmap's JSON. */
export function parseBlockMap(json: string): BlockMap {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new DiffError("blockmap");
  }
  const map = data as { version?: unknown; files?: unknown } | null;
  if (
    !map ||
    typeof map.version !== "string" ||
    !Array.isArray(map.files) ||
    map.files.length === 0
  )
    throw new DiffError("blockmap");
  const files: BlockMapFile[] = [];
  for (const raw of map.files) {
    const file = raw as Partial<BlockMapFile> | null;
    if (
      !file ||
      typeof file.name !== "string" ||
      !count(file.offset, 0) ||
      !Array.isArray(file.checksums) ||
      !Array.isArray(file.sizes) ||
      file.checksums.length !== file.sizes.length ||
      !file.checksums.every((sum) => typeof sum === "string") ||
      !file.sizes.every((size) => count(size, 1))
    )
      throw new DiffError("blockmap");
    const end = file.sizes.reduce((sum, size) => sum + size, file.offset!);
    if (!Number.isSafeInteger(end)) throw new DiffError("blockmap");
    files.push(file as BlockMapFile);
  }
  return { version: map.version, files };
}

function unpack(data: Buffer, inflate: typeof gunzipSync): BlockMap {
  if (data.length > MAX_BLOCKMAP_BYTES) throw new DiffError("blockmap");
  let json: string;
  try {
    json = inflate(data, { maxOutputLength: MAX_BLOCKMAP_JSON }).toString(
      "utf8",
    );
  } catch {
    throw new DiffError("blockmap");
  }
  return parseBlockMap(json);
}

/** A `.blockmap` release asset: gzip-compressed JSON. */
export const gzipBlockMap = (data: Buffer) => unpack(data, gunzipSync);
/** The blockmap at the end of an AppImage: raw-deflate JSON. */
export const embeddedBlockMap = (data: Buffer) => unpack(data, inflateRawSync);

/**
 * electron-builder appends an AppImage's blockmap to the file itself: the compressed blockmap, then its length as a
 * 4-byte big-endian number. Returns that length, refusing one that cannot fit in a file of `size` bytes.
 */
export function embeddedLength(trailer: Buffer, size: number): number {
  if (trailer.length !== 4) throw new DiffError("blockmap");
  const length = trailer.readUInt32BE(0);
  if (length === 0 || length > MAX_BLOCKMAP_BYTES || length + 4 > size)
    throw new DiffError("blockmap");
  return length;
}

/** The blockmap embedded in a local AppImage. */
export async function readEmbeddedBlockMap(path: string): Promise<BlockMap> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size < 4) throw new DiffError("blockmap");
    const trailer = Buffer.alloc(4);
    await file.read(trailer, 0, 4, size - 4);
    const length = embeddedLength(trailer, size);
    const data = Buffer.alloc(length);
    const { bytesRead } = await file.read(data, 0, length, size - 4 - length);
    if (bytesRead !== length) throw new DiffError("blockmap");
    return embeddedBlockMap(data);
  } finally {
    await file.close();
  }
}

/** The number of bytes a blockmap describes, from the start of the file. */
export function blockMapEnd(map: BlockMap): number {
  const file = map.files[0]!;
  return file.sizes.reduce((sum, size) => sum + size, file.offset);
}

/**
 * The copy and download steps that rebuild the new file from the old one, in the new file's order. Adjacent blocks
 * merge into one step. A checksum the old file lists twice uses its first block; one it lists with another size is
 * downloaded. This is electron-updater's `computeOperations`.
 */
export function planDownload(old: BlockMap, next: BlockMap): Operation[] {
  if (old.version !== next.version) throw new DiffError("plan");
  const file = next.files[0]!;
  const before = old.files.find((entry) => entry.name === file.name);
  if (!before) throw new DiffError("plan");
  const known = new Map<string, { offset: number; size: number }>();
  let offset = before.offset;
  for (let i = 0; i < before.checksums.length; i++) {
    if (!known.has(before.checksums[i]!))
      known.set(before.checksums[i]!, { offset, size: before.sizes[i]! });
    offset += before.sizes[i]!;
  }
  const operations: Operation[] = [];
  let last: Operation | undefined;
  offset = file.offset;
  for (let i = 0; i < file.checksums.length; offset += file.sizes[i]!, i++) {
    const size = file.sizes[i]!;
    const hit = known.get(file.checksums[i]!);
    const [kind, start] =
      hit && hit.size === size
        ? (["copy", hit.offset] as const)
        : (["download", offset] as const);
    if (last?.kind === kind && last.end === start) last.end += size;
    else operations.push((last = { kind, start, end: start + size }));
  }
  return operations;
}

/** The bytes a plan downloads. */
export const downloadBytes = (operations: Operation[]) =>
  operations.reduce(
    (sum, op) => sum + (op.kind === "download" ? op.end - op.start : 0),
    0,
  );

/**
 * Checks that `response` carries exactly bytes `[start, end)` of a file of `size` bytes: status 206 and a matching
 * Content-Range. A server that ignores Range answers 200 with the whole file, which is refused.
 */
async function rangeBody(
  response: Response,
  start: number,
  end: number,
  size: number,
): Promise<ReadableStream<Uint8Array>> {
  const range = response.headers
    .get("content-range")
    ?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
  const length = response.headers.get("content-length");
  if (
    response.status !== 206 ||
    !range ||
    Number(range[1]) !== start ||
    Number(range[2]) !== end - 1 ||
    (range[3] !== "*" && Number(range[3]) !== size) ||
    (length != null && Number(length) !== end - start) ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new DiffError("range");
  }
  return response.body;
}

/** Reads bytes `[start, end)` of a release file through `fetchRange`, refusing anything else. */
export async function readRange(
  fetchRange: (start: number, end: number) => Promise<Response>,
  start: number,
  end: number,
  size: number,
): Promise<Buffer> {
  const body = await rangeBody(await fetchRange(start, end), start, end, size);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > end - start) throw new DiffError("range");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  if (received !== end - start) throw new DiffError("range");
  return Buffer.concat(chunks);
}

/**
 * Writes the new file to `<dest>.part` by following `operations`: copy steps read the old file, download steps fetch
 * their range with `fetchRange`. `tail` (an AppImage's embedded blockmap and its length) goes last. The file is renamed
 * to `dest` only if it has `size` bytes and SHA-256 `sha256`; otherwise, and on any failure, the partial file is
 * deleted. `onProgress` receives the downloaded byte count, never the copied bytes. `onActivity` runs before each chunk
 * copied from the old file, so a caller's network idle limit does not run while the disk works.
 */
export async function assemble(input: {
  oldFile: string;
  operations: Operation[];
  dest: string;
  size: number;
  sha256: string;
  tail?: Buffer;
  fetchRange: (start: number, end: number) => Promise<Response>;
  signal: AbortSignal;
  onProgress?: (received: number) => void;
  onActivity?: () => void;
}): Promise<void> {
  const part = `${input.dest}.part`;
  const planned =
    input.operations.reduce((sum, op) => sum + op.end - op.start, 0) +
    (input.tail?.length ?? 0);
  if (planned !== input.size) throw new DiffError("plan");
  const hash = createHash("sha256");
  let old: FileHandle | undefined;
  let out: FileHandle | undefined;
  let written = 0;
  let received = 0;
  const write = async (bytes: Uint8Array) => {
    hash.update(bytes);
    await out!.write(bytes);
    written += bytes.length;
  };
  try {
    old = await open(input.oldFile, "r");
    const oldSize = (await old.stat()).size;
    out = await open(part, "w");
    const buffer = Buffer.alloc(COPY_CHUNK);
    for (const op of input.operations) {
      input.signal.throwIfAborted();
      if (op.kind === "copy") {
        if (op.end > oldSize) throw new DiffError("plan");
        for (let at = op.start; at < op.end;) {
          input.onActivity?.();
          const want = Math.min(COPY_CHUNK, op.end - at);
          const { bytesRead } = await old.read(buffer, 0, want, at);
          if (bytesRead !== want) throw new DiffError("plan");
          await write(buffer.subarray(0, want));
          at += want;
        }
        continue;
      }
      const body = await rangeBody(
        await input.fetchRange(op.start, op.end),
        op.start,
        op.end,
        input.size,
      );
      const reader = body.getReader();
      let got = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (got > op.end - op.start) throw new DiffError("range");
          await write(value);
          received += value.length;
          input.onProgress?.(received);
        }
      } finally {
        await reader.cancel();
      }
      if (got !== op.end - op.start) throw new DiffError("range");
    }
    if (input.tail) await write(input.tail);
    await out.close();
    out = undefined;
    if (written !== input.size || hash.digest("hex") !== input.sha256)
      throw new DiffError("mismatch");
    await rename(part, input.dest);
  } catch (error) {
    await out?.close();
    await rm(part, { force: true });
    throw error;
  } finally {
    await old?.close();
  }
}
