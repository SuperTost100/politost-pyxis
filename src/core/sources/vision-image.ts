import { statSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { isHeicExt, shrink } from "./heic";
import { readBoundedSync } from "./bounded-read";
import { runSourceWorker } from "./worker-client";

export type VisionMime = "image/png" | "image/jpeg" | "image/webp";

/** What goes to a vision model. `resizedFrom` is set only when the sent bytes differ from the file. */
export type VisionImage = {
  mediaType: VisionMime;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  resizedFrom?: { width: number; height: number; bytes: number };
  /** The EXIF orientation (2-8) that was applied, so the copy is upright. The stored original keeps its tag. */
  orientation?: number;
};

/**
 * Raw bytes per image. Anthropic documents 10 MB of base64 on the direct API, 5 MB on Bedrock and Vertex,
 * and 32 MB for the whole request (https://platform.claude.com/docs/en/build-with-claude/vision, checked 2026-10-04).
 * 1.5 MB raw is 2 MB of base64, so the 8 new and 4 saved images a chat turn can carry stay near 24 MB.
 */
export const VISION_MAX_BYTES = 1_500_000;
/** Resized photos aim here. The long edge limit is 8000 px, and a phone page is still legible at this size. */
export const VISION_MAX_EDGE = 2560;
const PROVIDER_MAX_EDGE = 8000;
/** RGBA is 4 bytes a pixel, so 60 MP is 240 MB. A 48 MP phone photo fits. */
export const MAX_DECODE_PIXELS = 60_000_000;
const MIN_EDGE = 640;

export function sniffImage(bytes: Uint8Array): VisionMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** The first frame header's size and the EXIF orientation, read by walking the JPEG segments. No pixels are decoded. */
function scanJpeg(b: Uint8Array): { size: { width: number; height: number } | null; orientation: number } {
  let orientation = 1;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1]!;
    if (marker === 0xff || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += marker === 0xff ? 1 : 2;
      continue;
    }
    // Past the scan or the end marker comes entropy data, not segments, and no frame header follows.
    if (marker === 0xda || marker === 0xd9) break;
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b.subarray(at + 4, at + 2 + length));
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { size: { height: (b[at + 5]! << 8) | b[at + 6]!, width: (b[at + 7]! << 8) | b[at + 8]! }, orientation };
    at += 2 + length;
  }
  return { size: null, orientation };
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const kind = String.fromCharCode(...b.subarray(12, 16));
  if (kind === "VP8X")
    return {
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    };
  if (kind === "VP8L") {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (kind === "VP8 ")
    return { width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  return null;
}

/**
 * Pixel size from the file header alone, so a decode bomb is refused before any pixel buffer exists.
 * Null means the header is malformed or declares no pixels, and the file is not trusted as an image.
 */
export function imageSize(bytes: Uint8Array, mime: VisionMime): { width: number; height: number } | null {
  let size: { width: number; height: number } | null;
  if (mime === "image/png") {
    // Signature, then the IHDR chunk (length 13) that must come first.
    const ihdr = bytes.length >= 26 && String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    size = ihdr && view.getUint32(8) === 13 ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
  } else size = mime === "image/jpeg" ? scanJpeg(bytes).size : webpSize(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** Refuses what cannot be decoded safely: a header that is unreadable or declares more pixels than a decode may take. */
export function assertDecodable(bytes: Uint8Array, mime: VisionMime): { width: number; height: number } {
  const size = imageSize(bytes, mime);
  if (!size) throw new Error("vision-image-unsupported");
  if (size.width * size.height > MAX_DECODE_PIXELS) throw new Error("vision-image-too-large");
  return size;
}

/**
 * The file itself, when a provider takes it as is. Null means it needs the resize path: it is too big, its header
 * does not read (so it is not trusted as sent), or it is a JPEG whose EXIF orientation providers do not apply.
 */
export function visionAsIs(bytes: Uint8Array): VisionImage | null {
  const mediaType = sniffImage(bytes);
  if (!mediaType || bytes.length > VISION_MAX_BYTES) return null;
  const size = imageSize(bytes, mediaType);
  // A picture too big to decode here is not sent as is either: the resize path refuses it by name.
  if (!size || Math.max(size.width, size.height) > PROVIDER_MAX_EDGE || size.width * size.height > MAX_DECODE_PIXELS)
    return null;
  if (mediaType === "image/jpeg" && scanJpeg(bytes).orientation > 1) return null;
  return { mediaType, bytes, ...size };
}

/** EXIF orientation 1-8 from the APP1 block jpeg-js hands back. Phones store portrait shots rotated with this tag. */
function exifOrientation(exif: Uint8Array | undefined): number {
  if (!exif) return 1;
  let tiff = -1;
  for (let at = 0; at < 8 && at + 8 <= exif.length; at += 1) {
    const little = exif[at] === 0x49 && exif[at + 1] === 0x49 && exif[at + 2] === 0x2a && exif[at + 3] === 0;
    const big = exif[at] === 0x4d && exif[at + 1] === 0x4d && exif[at + 2] === 0 && exif[at + 3] === 0x2a;
    if (little || big) {
      tiff = at;
      break;
    }
  }
  if (tiff < 0) return 1;
  const little = exif[tiff] === 0x49;
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength);
  const u16 = (at: number) => (at >= 0 && at + 2 <= exif.length ? view.getUint16(at, little) : 0);
  const ifd = tiff + (tiff + 8 <= exif.length ? view.getUint32(tiff + 4, little) : 0);
  const count = Math.min(u16(ifd), 64);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function orient(
  image: { data: Buffer; width: number; height: number },
  orientation: number,
): { data: Buffer; width: number; height: number } {
  if (orientation === 1) return image;
  const { width: w, height: h } = image;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [dx, dy] =
        orientation === 2 ? [w - 1 - x, y]
        : orientation === 3 ? [w - 1 - x, h - 1 - y]
        : orientation === 4 ? [x, h - 1 - y]
        : orientation === 5 ? [y, x]
        : orientation === 6 ? [h - 1 - y, x]
        : orientation === 7 ? [h - 1 - y, w - 1 - x]
        : [y, w - 1 - x];
      image.data.copy(out, (dy! * ow + dx!) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
    }
  }
  return { data: out, width: ow, height: swap ? w : h };
}

/** The caller has run `assertDecodable`, so the header is readable and the pixel count is bounded. */
function decode(bytes: Uint8Array, mime: VisionMime): { data: Uint8Array; width: number; height: number; orientation: number } {
  try {
    if (mime === "image/jpeg") {
      const image = jpeg.decode(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: MAX_DECODE_PIXELS / 1e6,
        maxMemoryUsageInMB: 768,
      });
      return { data: image.data, width: image.width, height: image.height, orientation: exifOrientation((image as { exifBuffer?: Uint8Array }).exifBuffer) };
    }
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    // JPEG has no alpha. Transparent pixels go to white, like the page a photo of paper shows.
    for (let at = 0; at < png.data.length; at += 4) {
      const alpha = png.data[at + 3]!;
      if (alpha === 255) continue;
      for (let c = 0; c < 3; c += 1) png.data[at + c] = Math.round((png.data[at + c]! * alpha + 255 * (255 - alpha)) / 255);
    }
    return { data: png.data, width: png.width, height: png.height, orientation: 1 };
  } catch (error) {
    throw new Error("vision-image-unsupported");
  }
}

/**
 * Fit an image to the provider limits. Used inside the extract worker, because decoding a phone photo takes
 * seconds and core must stay free. A file already inside the limits comes back untouched. JPEG and PNG are
 * decoded, turned upright by EXIF, shrunk to 2560 px and re-encoded as JPEG, stepping quality and size down
 * until it fits. A small JPEG whose EXIF orientation is not upright takes this path too, since providers
 * ignore the tag. WebP has no decoder here, so an oversized one is refused (`vision-image-too-large`).
 * Errors: `vision-image-unsupported` (not a readable JPEG, PNG or WebP, or a header that declares no size), `vision-image-too-large`.
 */
export function normalizeForVision(bytes: Uint8Array): VisionImage {
  const asIs = visionAsIs(bytes);
  if (asIs) return asIs;
  const mime = sniffImage(bytes);
  if (!mime) throw new Error("vision-image-unsupported");
  assertDecodable(bytes, mime);
  if (mime === "image/webp") throw new Error("vision-image-too-large");
  const source = decode(bytes, mime);
  let edge = Math.min(VISION_MAX_EDGE, Math.max(source.width, source.height));
  let quality = 85;
  for (;;) {
    const small = orient(shrink(source.data, source.width, source.height, edge), source.orientation);
    const encoded = jpeg.encode({ data: small.data, width: small.width, height: small.height }, quality).data;
    if (encoded.length <= VISION_MAX_BYTES)
      return {
        mediaType: "image/jpeg",
        bytes: new Uint8Array(encoded),
        width: small.width,
        height: small.height,
        resizedFrom: {
          width: source.orientation >= 5 ? source.height : source.width,
          height: source.orientation >= 5 ? source.width : source.height,
          bytes: bytes.length,
        },
        ...(source.orientation > 1 ? { orientation: source.orientation } : {}),
      };
    if (quality > 55) quality -= 15;
    else if (edge > MIN_EDGE) {
      edge = Math.max(MIN_EDGE, Math.floor(edge * 0.8));
      quality = 75;
    } else throw new Error("vision-image-too-large");
  }
}

/**
 * Pixels for local OCR. The recognizer ignores the EXIF tag, so a JPEG stored sideways is read sideways. Such a file
 * is turned upright at its own pixel size, as lossless PNG, so OCR sees the same resolution as the original. Anything
 * else comes back untouched. Errors as `assertDecodable`.
 */
export function uprightForOcr(bytes: Uint8Array): Uint8Array {
  if (sniffImage(bytes) !== "image/jpeg" || scanJpeg(bytes).orientation <= 1) return bytes;
  assertDecodable(bytes, "image/jpeg");
  const source = decode(bytes, "image/jpeg");
  const upright = orient(
    { data: Buffer.from(source.data.buffer, source.data.byteOffset, source.data.byteLength), width: source.width, height: source.height },
    source.orientation,
  );
  const png = new PNG({ width: upright.width, height: upright.height });
  upright.data.copy(png.data);
  // Level 1: the file only feeds the recognizer, so speed matters more than size.
  return new Uint8Array(PNG.sync.write(png, { deflateLevel: 1 }));
}

/**
 * A file ready for a vision model. A small, in-limit file is read here (it is at most 1.5 MB). Everything else,
 * including every HEIC, goes to the extract worker.
 */
export async function loadVisionImage(
  path: string,
  ext: string,
  signal?: AbortSignal,
  work: typeof runSourceWorker = runSourceWorker,
): Promise<VisionImage> {
  if (!isHeicExt(ext) && statSync(path).size <= VISION_MAX_BYTES) {
    const asIs = visionAsIs(readBoundedSync(path, VISION_MAX_BYTES));
    if (asIs) return asIs;
  }
  return work<VisionImage>("extract-worker", { path, ext, mode: "vision" }, signal);
}
