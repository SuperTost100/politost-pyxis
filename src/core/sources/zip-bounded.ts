import { Inflate } from "fflate";

export type ZipLimits = {
  maxEntries: number;
  /** Most bytes one entry may inflate to. */
  maxEntryBytes: number;
  /** Most bytes all the entries read from this archive may inflate to, together. */
  maxTotalBytes: number;
};

// One deflate push can expand ~1032x before it emits, so small pushes bound the transient memory (~16 MiB), as in backup.ts.
const INFLATE_CHUNK = 16 * 1024;

export type BoundedZip = {
  names: string[];
  has(name: string): boolean;
  /** The entry's bytes, or undefined when it is absent. Throws `archive-too-large` as soon as the output passes a limit. */
  read(name: string): Uint8Array | undefined;
};

/**
 * Reads entries of an in-memory ZIP (a .docx or .pptx) without trusting its headers. The central directory only says
 * where an entry's compressed bytes are; the size it declares is ignored, and the bytes are inflated in small pushes
 * while the real output is counted against `maxEntryBytes` and a total shared by every `read`. A header that lies
 * about its size, or entries that overlap to reuse one compressed run, cannot exceed those limits. Entries that are not
 * read are never inflated, so a media folder costs nothing. ZIP64, encryption and methods other than stored/deflate are
 * refused. Errors: `archive-corrupt`, `archive-unsupported`, `archive-too-large`.
 * ponytail: no CRC check, which jszip and unzipSync did not make either; a damaged entry fails in the XML parse that follows.
 */
export function openZip(bytes: Uint8Array, limits: ZipLimits): BoundedZip {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const corrupt = (): never => {
    throw new Error("archive-corrupt");
  };
  if (view.length < 22) corrupt();
  let eocd = -1;
  for (
    let i = view.length - 22;
    i >= Math.max(0, view.length - 22 - 0xffff);
    i -= 1
  ) {
    if (view.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) corrupt();
  const count = view.readUInt16LE(eocd + 10);
  const directorySize = view.readUInt32LE(eocd + 12);
  const directoryOffset = view.readUInt32LE(eocd + 16);
  if (
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw new Error("archive-unsupported");
  if (count > limits.maxEntries) throw new Error("archive-too-large");
  if (directoryOffset + directorySize > eocd) corrupt();
  const entries = new Map<
    string,
    { method: number; packed: number; offset: number }
  >();
  let position = directoryOffset;
  for (let n = 0; n < count; n += 1) {
    if (position + 46 > eocd || view.readUInt32LE(position) !== 0x02014b50)
      corrupt();
    const flags = view.readUInt16LE(position + 8);
    const method = view.readUInt16LE(position + 10);
    const packed = view.readUInt32LE(position + 20);
    const nameLength = view.readUInt16LE(position + 28);
    const rest =
      view.readUInt16LE(position + 30) + view.readUInt16LE(position + 32);
    const offset = view.readUInt32LE(position + 42);
    if (position + 46 + nameLength + rest > eocd) corrupt();
    const name = view.toString(
      "utf8",
      position + 46,
      position + 46 + nameLength,
    );
    position += 46 + nameLength + rest;
    if (flags & 0x1 || packed === 0xffffffff || offset === 0xffffffff)
      throw new Error("archive-unsupported");
    if (!entries.has(name)) entries.set(name, { method, packed, offset });
  }
  let total = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      if (entry.method !== 0 && entry.method !== 8)
        throw new Error("archive-unsupported");
      const { offset, packed } = entry;
      if (
        offset + 30 > directoryOffset ||
        view.readUInt32LE(offset) !== 0x04034b50
      )
        corrupt();
      const start =
        offset +
        30 +
        view.readUInt16LE(offset + 26) +
        view.readUInt16LE(offset + 28);
      if (start + packed > directoryOffset) corrupt();
      const room = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
      if (entry.method === 0) {
        if (packed > room) throw new Error("archive-too-large");
        total += packed;
        return view.subarray(start, start + packed);
      }
      const out: Uint8Array[] = [];
      let produced = 0;
      let batch: Uint8Array[] = [];
      const inflate = new Inflate((chunk) => {
        batch.push(chunk);
      });
      for (let at = start; at < start + packed; at += INFLATE_CHUNK) {
        const end = Math.min(start + packed, at + INFLATE_CHUNK);
        try {
          inflate.push(view.subarray(at, end), end === start + packed);
        } catch {
          corrupt();
        }
        for (const piece of batch) {
          produced += piece.length;
          if (produced > room) throw new Error("archive-too-large");
          out.push(piece);
        }
        batch = [];
      }
      total += produced;
      return Buffer.concat(out);
    },
  };
}
