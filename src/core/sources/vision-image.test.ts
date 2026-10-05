import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { grayFromImage, imageVariance, recognizeImage } from "./recognize";
import {
  assertDecodable,
  imageSize,
  loadVisionImage,
  normalizeForVision,
  sniffImage,
  uprightForOcr,
  visionAsIs,
  VISION_MAX_BYTES,
  VISION_MAX_EDGE,
} from "./vision-image";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-vision-image-"));
  dirs.push(dir);
  return dir;
};

/** Deterministic noise keeps the file big, like a photo of paper does. */
function pixels(width: number, height: number, color: (x: number, y: number) => [number, number, number], noise = 60) {
  const data = Buffer.alloc(width * height * 4);
  let seed = 7;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const [r, g, b] = color(x, y);
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed % (noise * 2)) - noise;
      data[at] = Math.max(0, Math.min(255, r + n));
      data[at + 1] = Math.max(0, Math.min(255, g + n));
      data[at + 2] = Math.max(0, Math.min(255, b + n));
      data[at + 3] = 255;
    }
  return data;
}
const jpegOf = (width: number, height: number, color: Parameters<typeof pixels>[2], quality = 92) =>
  new Uint8Array(jpeg.encode({ data: pixels(width, height, color), width, height }, quality).data);

/** Splices an EXIF block with this orientation in after the SOI marker. */
function withOrientation(file: Uint8Array, orientation: number): Uint8Array {
  const exif = Buffer.concat([
    Buffer.from("Exif\0\0", "binary"),
    Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]),
    Buffer.from([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]),
  ]);
  const block = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  return new Uint8Array(Buffer.concat([file.subarray(0, 2), block, file.subarray(2)]));
}

const redBlue = (x: number, y: number): [number, number, number] => (x < 1500 ? [220, 30, 30] : [30, 30, 220]);

describe("SRC-04 images fit provider limits before they are sent", () => {
  it("passes a small image through untouched, whatever its extension said", () => {
    const small = jpegOf(200, 150, () => [120, 120, 120], 80);
    expect(small.length).toBeLessThan(VISION_MAX_BYTES);
    const result = normalizeForVision(small);
    expect(result.bytes).toBe(small);
    expect(result).toMatchObject({ mediaType: "image/jpeg", width: 200, height: 150 });
    expect(result.resizedFrom).toBeUndefined();
  });

  it("reads sizes from the header alone", () => {
    const png = PNG.sync.write(new PNG({ width: 31, height: 17 }));
    expect(imageSize(png, "image/png")).toEqual({ width: 31, height: 17 });
    expect(imageSize(jpegOf(40, 30, () => [9, 9, 9]), "image/jpeg")).toEqual({ width: 40, height: 30 });
    expect(sniffImage(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("shrinks and re-encodes a phone-size photo under the byte budget", () => {
    const photo = jpegOf(3600, 2400, redBlue);
    expect(photo.length).toBeGreaterThan(VISION_MAX_BYTES);
    const result = normalizeForVision(photo);
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.bytes.length).toBeLessThanOrEqual(VISION_MAX_BYTES);
    expect(Math.max(result.width!, result.height!)).toBeLessThanOrEqual(VISION_MAX_EDGE);
    expect(result.resizedFrom).toEqual({ width: 3600, height: 2400, bytes: photo.length });
    const decoded = jpeg.decode(Buffer.from(result.bytes), { useTArray: true });
    expect([decoded.width, decoded.height]).toEqual([result.width, result.height]);
  }, 60_000);

  it("turns a rotated phone photo upright from its EXIF tag", () => {
    // Stored 3000x2000, tagged 6: the display is 2000x3000 and the left (red) side ends up on top.
    const tagged = withOrientation(jpegOf(3000, 2000, redBlue), 6);
    expect(tagged.length).toBeGreaterThan(VISION_MAX_BYTES);
    const result = normalizeForVision(tagged);
    expect(result.height!).toBeGreaterThan(result.width!);
    expect(result.resizedFrom).toMatchObject({ width: 2000, height: 3000 });
    const decoded = jpeg.decode(Buffer.from(result.bytes), { useTArray: true });
    const at = (x: number, y: number) => decoded.data.slice((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 3);
    const middle = Math.floor(decoded.width / 2);
    expect(at(middle, 20)[0]).toBeGreaterThan(150);
    expect(at(middle, decoded.height - 20)[2]).toBeGreaterThan(150);
  }, 60_000);

  it("flattens a large transparent PNG onto white", () => {
    const png = new PNG({ width: 2400, height: 1600 });
    pixels(2400, 1600, () => [40, 90, 160]).copy(png.data);
    // The left quarter is fully transparent, with black behind it.
    for (let y = 0; y < 1600; y += 1)
      for (let x = 0; x < 600; x += 1) {
        const at = (y * 2400 + x) * 4;
        png.data.fill(0, at, at + 4);
      }
    const file = new Uint8Array(PNG.sync.write(png));
    expect(file.length).toBeGreaterThan(VISION_MAX_BYTES);
    const result = normalizeForVision(file);
    expect(result.mediaType).toBe("image/jpeg");
    const decoded = jpeg.decode(Buffer.from(result.bytes), { useTArray: true });
    const px = (decoded.width * 0.1) | 0;
    const py = (decoded.height / 2) | 0;
    expect(decoded.data[(py * decoded.width + px) * 4]).toBeGreaterThan(235);
  }, 60_000);

  it("refuses a decode bomb from its header before decoding", () => {
    const bomb = new Uint8Array(PNG.sync.write(new PNG({ width: 2, height: 2 })));
    new DataView(bomb.buffer, bomb.byteOffset).setUint32(16, 20_000);
    new DataView(bomb.buffer, bomb.byteOffset).setUint32(20, 20_000);
    expect(() => normalizeForVision(bomb)).toThrow("vision-image-too-large");
  });

  it("does not send a small JPEG as is when its EXIF orientation is not upright", () => {
    // 40 KB, far inside every limit, but a provider would show it sideways because it ignores the tag.
    const small = withOrientation(jpegOf(300, 200, redBlue, 70), 6);
    expect(small.length).toBeLessThan(VISION_MAX_BYTES);
    expect(visionAsIs(small)).toBeNull();
    const result = normalizeForVision(small);
    expect(result).toMatchObject({ mediaType: "image/jpeg", width: 200, height: 300, orientation: 6 });
    expect(result.resizedFrom).toEqual({ width: 200, height: 300, bytes: small.length });
    // The stored original is not touched: the input still carries its tag and its bytes.
    expect(visionAsIs(withOrientation(jpegOf(300, 200, redBlue, 70), 1))).not.toBeNull();
    const upright = jpegOf(300, 200, redBlue, 70);
    expect(normalizeForVision(upright).bytes).toBe(upright);
    expect(normalizeForVision(upright).orientation).toBeUndefined();
  });

  it("turns a sideways JPEG upright for OCR at its full size, and leaves every other file alone", () => {
    // 3000x2000 tagged 6 is bigger than the vision edge limit, and OCR must still get all of it.
    const tagged = withOrientation(jpegOf(3000, 2000, redBlue), 6);
    const upright = PNG.sync.read(Buffer.from(uprightForOcr(tagged)));
    expect([upright.width, upright.height]).toEqual([2000, 3000]);
    expect(Math.max(upright.width, upright.height)).toBeGreaterThan(VISION_MAX_EDGE);
    const at = (x: number, y: number) => upright.data[(y * upright.width + x) * 4]!;
    expect(at(1000, 20)).toBeGreaterThan(150);
    // Untagged, tagged upright, and non-JPEG input come back as the same bytes, with no decode.
    const plain = jpegOf(300, 200, redBlue, 70);
    expect(uprightForOcr(plain)).toBe(plain);
    const flat = withOrientation(plain, 1);
    expect(uprightForOcr(flat)).toBe(flat);
    const png = new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })));
    expect(uprightForOcr(png)).toBe(png);
  }, 60_000);

  it("stops walking a JPEG at its scan, so entropy bytes are never taken for a frame header", () => {
    const fakeFrame = [0xff, 0xc0, 0, 17, 8, 0xff, 0xff, 0xff, 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const bent = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, ...fakeFrame]);
    expect(imageSize(bent, "image/jpeg")).toBeNull();
    expect(imageSize(jpegOf(300, 200, redBlue, 70), "image/jpeg")).toEqual({ width: 300, height: 200 });
  });

  it("refuses an image whose header is unreadable or declares no pixels instead of sending it", () => {
    const png = new Uint8Array(PNG.sync.write(new PNG({ width: 20, height: 10 })));
    const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset);
    // Zero width, and a first chunk that is not IHDR.
    const zero = png.slice();
    view(zero).setUint32(16, 0);
    const notIhdr = png.slice();
    notIhdr.set(new TextEncoder().encode("IDAT"), 12);
    // A JPEG with no frame header at all: a marker walk finds no size.
    const headless = new Uint8Array(200).fill(0);
    headless.set([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
    // A WebP whose container is not VP8, VP8L or VP8X.
    const webp = new Uint8Array(64);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBP"), 8);
    for (const bad of [zero, notIhdr, headless, webp]) {
      expect(imageSize(bad, sniffImage(bad)!)).toBeNull();
      expect(visionAsIs(bad)).toBeNull();
      expect(() => normalizeForVision(bad)).toThrow("vision-image-unsupported");
    }
    // A truncated PNG with a good signature and no room for a header.
    expect(() => normalizeForVision(png.slice(0, 20))).toThrow("vision-image-unsupported");
  });

  it("does not let a small file that declares a huge picture past the pixel check", async () => {
    const bomb = new Uint8Array(PNG.sync.write(new PNG({ width: 2, height: 2 })));
    new DataView(bomb.buffer, bomb.byteOffset).setUint32(16, 7_900);
    new DataView(bomb.buffer, bomb.byteOffset).setUint32(20, 7_900);
    // 62 MP is inside the provider's edge limit but past what a decode may take, and under the byte budget.
    expect(bomb.length).toBeLessThan(VISION_MAX_BYTES);
    expect(() => assertDecodable(bomb, "image/png")).toThrow("vision-image-too-large");
    expect(visionAsIs(bomb)).toBeNull();
    expect(() => normalizeForVision(bomb)).toThrow("vision-image-too-large");
    expect(() => grayFromImage(bomb)).toThrow("vision-image-too-large");
    // Local OCR decodes the whole picture too, so it refuses before it starts a recognizer.
    await expect(recognizeImage(bomb, scratch())).rejects.toThrow("vision-image-too-large");
    // The blur check refuses it from the header too, before any pixel buffer exists.
    expect(() => imageVariance(bomb)).toThrow("vision-image-too-large");
  });

  it("refuses to OCR a type it cannot size, so a TIFF or BMP decode bomb never reaches the recognizer", async () => {
    // A little-endian TIFF whose one IFD declares 60,000 x 60,000 pixels, in 38 bytes.
    const tiff = Buffer.alloc(38);
    tiff.write("II", 0, "latin1");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(2, 8);
    tiff.writeUInt16LE(256, 10); // ImageWidth
    tiff.writeUInt16LE(4, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt32LE(60_000, 18);
    tiff.writeUInt16LE(257, 22); // ImageLength
    tiff.writeUInt16LE(4, 24);
    tiff.writeUInt32LE(1, 26);
    tiff.writeUInt32LE(60_000, 30);
    // A BMP header that declares 40,000 x 40,000 pixels.
    const bmp = Buffer.alloc(54);
    bmp.write("BM", 0, "latin1");
    bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(40_000, 18);
    bmp.writeInt32LE(40_000, 22);
    bmp.writeUInt16LE(1, 26);
    bmp.writeUInt16LE(24, 28);
    const gif = Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1");
    for (const [name, bytes] of [["tiff", tiff], ["bmp", bmp], ["gif", gif], ["empty", Buffer.alloc(0)]] as const) {
      await expect(recognizeImage(new Uint8Array(bytes), scratch()), name).rejects.toThrow("vision-image-unsupported");
    }
  });

  it("names what it cannot fit", () => {
    expect(() => normalizeForVision(new Uint8Array([1, 2, 3, 4]))).toThrow("vision-image-unsupported");
    // Looks like a JPEG, is over the budget, and is not one.
    const broken = new Uint8Array(VISION_MAX_BYTES + 10).fill(0x55);
    broken.set([0xff, 0xd8, 0xff]);
    expect(() => normalizeForVision(broken)).toThrow("vision-image-unsupported");
    // A readable WebP header (VP8X, 100x100) over the budget: no decoder here, so it is too large to fit.
    const webp = new Uint8Array(VISION_MAX_BYTES + 100);
    webp.set(new TextEncoder().encode("RIFF"), 0);
    webp.set(new TextEncoder().encode("WEBP"), 8);
    webp.set(new TextEncoder().encode("VP8X"), 12);
    webp.set([99, 0, 0, 99, 0, 0], 24);
    expect(() => normalizeForVision(webp)).toThrow("vision-image-too-large");
  });

  it("reads a small file in place and sends a large one or any HEIC to the worker", async () => {
    const dir = scratch();
    const small = join(dir, "small.jpg");
    const large = join(dir, "large.jpg");
    writeFileSync(small, jpegOf(100, 80, () => [1, 2, 3], 50));
    writeFileSync(large, new Uint8Array(VISION_MAX_BYTES + 1).fill(0xff));
    const calls: unknown[] = [];
    const work = (async (_name: string, input: unknown) => {
      calls.push(input);
      return { mediaType: "image/jpeg", bytes: new Uint8Array([1]) };
    }) as never;
    expect((await loadVisionImage(small, ".jpg", undefined, work)).width).toBe(100);
    expect(calls).toHaveLength(0);
    await loadVisionImage(large, ".jpg", undefined, work);
    await loadVisionImage(small, ".heic", undefined, work);
    expect(calls).toEqual([
      { path: large, ext: ".jpg", mode: "vision" },
      { path: small, ext: ".heic", mode: "vision" },
    ]);
  });
});
