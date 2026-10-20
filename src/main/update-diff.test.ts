import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import {
  assemble,
  blockMapEnd,
  DiffError,
  downloadBytes,
  embeddedBlockMap,
  embeddedLength,
  gzipBlockMap,
  parseBlockMap,
  planDownload,
  readEmbeddedBlockMap,
  readRange,
  type BlockMap,
} from "./update-diff";

const roots: string[] = [];
const servers: Server[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "pyxis-update-diff-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((server) => new Promise((r) => server.close(r))),
  );
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
/** Blocks of `size` bytes filled with `seed`, so equal seeds make equal blocks. */
const block = (seed: number, size = 1000) => Buffer.alloc(size, seed);
/** A blockmap as electron-builder writes it, with SHA-256 standing in for its BLAKE2 checksums. */
function blockMapOf(blocks: Buffer[]): BlockMap {
  return {
    version: "2",
    files: [
      {
        name: "file",
        offset: 0,
        checksums: blocks.map((b) =>
          createHash("sha256").update(b).digest("base64"),
        ),
        sizes: blocks.map((b) => b.length),
      },
    ],
  };
}
/** An AppImage-like file: the blocks, then the raw-deflate blockmap and its 4-byte big-endian length. */
function withEmbeddedMap(blocks: Buffer[]): Buffer {
  const map = deflateRawSync(JSON.stringify(blockMapOf(blocks)));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(map.length);
  return Buffer.concat([...blocks, map, length]);
}

/**
 * A local HTTP server for `file`. With `ranges`, it answers a single `bytes=a-b` Range with 206 the way GitHub's asset
 * host does; `lie` changes the answer to test the checks. It counts requests and the body bytes it sent.
 */
async function serve(
  file: Buffer,
  options: { ranges?: boolean; lie?: "content-range" | "short" } = {},
) {
  const served = { requests: 0, bytes: 0 };
  const server = createServer((request, response) => {
    served.requests++;
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!options.ranges || !range) {
      served.bytes += file.length;
      response.writeHead(200, { "content-length": file.length });
      return response.end(file);
    }
    const start = Number(range[1]);
    const end = Number(range[2]);
    let body = file.subarray(start, end + 1);
    const shown = options.lie === "content-range" ? start + 1 : start;
    if (options.lie === "short") body = body.subarray(1);
    served.bytes += body.length;
    response.writeHead(206, {
      "content-range": `bytes ${shown}-${end}/${file.length}`,
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const fetchRange = (start: number, end: number) =>
    fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  return { served, fetchRange };
}

it("reads gzip and embedded blockmaps and refuses malformed or oversized ones", () => {
  const map = blockMapOf([block(1), block(2, 500)]);
  expect(gzipBlockMap(gzipSync(JSON.stringify(map)))).toEqual(map);
  expect(embeddedBlockMap(deflateRawSync(JSON.stringify(map)))).toEqual(map);
  expect(blockMapEnd(map)).toBe(1500);
  const file = map.files[0]!;
  for (const bad of [
    "not json",
    "null",
    JSON.stringify({ version: 2, files: [file] }),
    JSON.stringify({ version: "2", files: [] }),
    JSON.stringify({ version: "2", files: [{ ...file, offset: -1 }] }),
    JSON.stringify({ version: "2", files: [{ ...file, sizes: [1000] }] }),
    JSON.stringify({ version: "2", files: [{ ...file, sizes: [1000, 0] }] }),
    JSON.stringify({ version: "2", files: [{ ...file, sizes: [1, 0.5] }] }),
    JSON.stringify({ version: "2", files: [{ ...file, checksums: [1, 2] }] }),
    JSON.stringify({
      version: "2",
      files: [{ ...file, sizes: [Number.MAX_SAFE_INTEGER, 1] }],
    }),
  ])
    expect(() => parseBlockMap(bad), bad).toThrow(DiffError);
  expect(() => gzipBlockMap(Buffer.from("not gzip"))).toThrow(DiffError);
  // A small archive that unpacks past the limit is refused, not inflated.
  expect(() =>
    gzipBlockMap(gzipSync(Buffer.alloc(65 * 1024 * 1024, 32))),
  ).toThrow(DiffError);
});

it("plans copies for blocks the old file has and downloads for the rest, merging neighbours", () => {
  const old = blockMapOf([block(1), block(2), block(3), block(4), block(2)]);
  const next = blockMapOf([
    block(1),
    block(2),
    block(9),
    block(8),
    block(4),
    block(3),
    block(3, 400),
  ]);
  expect(planDownload(old, next)).toEqual([
    // Blocks 1 and 2 sit next to each other in both files: one copy. The second copy of block 2 is never used.
    { kind: "copy", start: 0, end: 2000 },
    // Two new blocks in a row: one download from the new file's offsets.
    { kind: "download", start: 2000, end: 4000 },
    { kind: "copy", start: 3000, end: 4000 },
    { kind: "copy", start: 2000, end: 3000 },
    // Same content seed but another size is another checksum, so it is downloaded.
    { kind: "download", start: 6000, end: 6400 },
  ]);
  expect(downloadBytes(planDownload(old, next))).toBe(2400);

  // A checksum the old file lists with another size is downloaded, as electron-updater does.
  const sized = blockMapOf([block(1)]);
  sized.files[0]!.sizes = [999];
  expect(planDownload(sized, blockMapOf([block(1)]))).toEqual([
    { kind: "download", start: 0, end: 1000 },
  ]);
  expect(() => planDownload({ ...old, version: "1" }, next)).toThrow(DiffError);
  const renamed = blockMapOf([block(1)]);
  renamed.files[0]!.name = "other";
  expect(() => planDownload(renamed, next)).toThrow(DiffError);
});

it("reads the blockmap embedded at the end of an AppImage and refuses a file without one", async () => {
  const root = temp();
  const blocks = [block(1), block(2), block(3)];
  const appImage = join(root, "Pyxis.AppImage");
  writeFileSync(appImage, withEmbeddedMap(blocks));
  expect(await readEmbeddedBlockMap(appImage)).toEqual(blockMapOf(blocks));
  for (const bytes of [
    Buffer.from("ab"),
    Buffer.from("an AppImage built without a blockmap"),
    Buffer.concat([Buffer.alloc(100), Buffer.from([0, 0, 0, 0])]),
  ]) {
    writeFileSync(appImage, bytes);
    await expect(readEmbeddedBlockMap(appImage)).rejects.toThrow(DiffError);
  }
  expect(() => embeddedLength(Buffer.from([0, 0, 0, 200]), 100)).toThrow(
    DiffError,
  );
  expect(embeddedLength(Buffer.from([0, 0, 0, 96]), 100)).toBe(96);
});

it("rebuilds the new file from the old one and Range requests to a local server", async () => {
  const root = temp();
  const oldBlocks = [block(1), block(2), block(3), block(4)];
  const newBlocks = [block(1), block(7), block(3), block(4), block(8, 300)];
  const oldFile = join(root, "old.AppImage");
  writeFileSync(oldFile, withEmbeddedMap(oldBlocks));
  const next = withEmbeddedMap(newBlocks);
  const { served, fetchRange } = await serve(next, { ranges: true });

  // What the updater does for an AppImage: read the remote trailer and blockmap by Range, then plan.
  const trailer = await readRange(
    fetchRange,
    next.length - 4,
    next.length,
    next.length,
  );
  const length = embeddedLength(trailer, next.length);
  const data = await readRange(
    fetchRange,
    next.length - 4 - length,
    next.length - 4,
    next.length,
  );
  const operations = planDownload(
    await readEmbeddedBlockMap(oldFile),
    embeddedBlockMap(data),
  );
  expect(downloadBytes(operations)).toBe(1300);
  served.requests = 0;
  served.bytes = 0;
  const progress: number[] = [];
  const dest = join(root, "new.AppImage");
  await assemble({
    oldFile,
    operations,
    dest,
    size: next.length,
    sha256: sha(next),
    tail: Buffer.concat([data, trailer]),
    fetchRange,
    signal: new AbortController().signal,
    onProgress: (received) => progress.push(received),
  });
  expect(readFileSync(dest)).toEqual(next);
  expect(readdirSync(root).sort()).toEqual(["new.AppImage", "old.AppImage"]);
  // One request per changed run, and only the changed bytes.
  expect(served).toEqual({ requests: 2, bytes: 1300 });
  expect(progress.at(-1)).toBe(1300);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
});

it("refuses a server that ignores Range, a wrong Content-Range or a short body, and leaves no partial file", async () => {
  const root = temp();
  const oldBlocks = [block(1), block(2)];
  const newBlocks = [block(1), block(5)];
  const oldFile = join(root, "old.zip");
  writeFileSync(oldFile, Buffer.concat(oldBlocks));
  const next = Buffer.concat(newBlocks);
  const operations = planDownload(blockMapOf(oldBlocks), blockMapOf(newBlocks));
  for (const options of [
    { ranges: false },
    { ranges: true, lie: "content-range" as const },
    { ranges: true, lie: "short" as const },
  ]) {
    const { fetchRange } = await serve(next, options);
    const error = await assemble({
      oldFile,
      operations,
      dest: join(root, "new.zip"),
      size: next.length,
      sha256: sha(next),
      fetchRange,
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error, JSON.stringify(options)).toBeInstanceOf(DiffError);
    expect((error as DiffError).reason).toBe("range");
    expect(readdirSync(root)).toEqual(["old.zip"]);
  }
});

it("deletes the rebuilt file when its SHA-256 differs from the release's", async () => {
  const root = temp();
  const oldBlocks = [block(1), block(2)];
  const newBlocks = [block(1), block(5)];
  const oldFile = join(root, "old.zip");
  // The old file no longer matches its blockmap, so the copied block is wrong.
  writeFileSync(oldFile, Buffer.concat([block(6), block(2)]));
  const next = Buffer.concat(newBlocks);
  const { fetchRange } = await serve(next, { ranges: true });
  const error = await assemble({
    oldFile,
    operations: planDownload(blockMapOf(oldBlocks), blockMapOf(newBlocks)),
    dest: join(root, "new.zip"),
    size: next.length,
    sha256: sha(next),
    fetchRange,
    signal: new AbortController().signal,
  }).catch((caught: unknown) => caught);
  expect((error as DiffError).reason).toBe("mismatch");
  expect(existsSync(join(root, "new.zip"))).toBe(false);
  expect(existsSync(join(root, "new.zip.part"))).toBe(false);

  // A plan that does not add up to the release's size never starts.
  await expect(
    assemble({
      oldFile,
      operations: [{ kind: "copy", start: 0, end: 10 }],
      dest: join(root, "new.zip"),
      size: next.length,
      sha256: sha(next),
      fetchRange,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(DiffError);
});

it("reports activity before every chunk it copies from the old file", async () => {
  const root = temp();
  // Two blocks of 1.5 MB each: the copy step spans two 1 MiB chunks.
  const unchanged = [block(1, 1_500_000), block(2, 1_500_000)];
  const oldFile = join(root, "old.zip");
  writeFileSync(oldFile, Buffer.concat(unchanged));
  const operations = planDownload(blockMapOf(unchanged), blockMapOf(unchanged));
  expect(operations).toEqual([{ kind: "copy", start: 0, end: 3_000_000 }]);
  const next = Buffer.concat(unchanged);
  const { fetchRange } = await serve(next, { ranges: true });
  let activity = 0;
  await assemble({
    oldFile,
    operations,
    dest: join(root, "new.zip"),
    size: next.length,
    sha256: sha(next),
    fetchRange,
    signal: new AbortController().signal,
    onActivity: () => activity++,
  });
  expect(activity).toBe(3);
});
