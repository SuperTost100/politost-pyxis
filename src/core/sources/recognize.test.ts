import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ocrDataDir } from "./ocr-data";
import { imageVariance, recognizeImage } from "./recognize";

// The pinned language files, from the git-ignored dev download (`.tmp/tessdata-fast`, see ocr-data.test.ts). Without
// them the tests that read pixels are skipped by name, and the no-data cases below still run.
const pinned = process.env.PYXIS_TEST_TESSDATA ?? join(import.meta.dirname, "../../../.tmp/tessdata-fast");
const haveData = existsSync(join(pinned, "eng.traineddata")) && existsSync(join(pinned, "ita.traineddata"));
function stagedData(): string {
  const tess = mkdtempSync(join(tmpdir(), "pyxis-tess-"));
  mkdirSync(ocrDataDir(tess), { recursive: true });
  for (const lang of ["eng", "ita"]) copyFileSync(join(pinned, `${lang}.traineddata`), join(ocrDataDir(tess), `${lang}.traineddata`));
  return tess;
}

const FONT: Record<string, string[]> = {
  H: ["#...#", "#...#", "#####", "#...#", "#...#", "#...#", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  O: ["#####", "#...#", "#...#", "#...#", "#...#", "#...#", "#####"],
};

function textPng(word: string): Buffer {
  const scale = 12;
  const margin = 48;
  const gap = 16;
  const letterW = 5 * scale;
  const width = margin * 2 + word.length * letterW + (word.length - 1) * gap;
  const height = margin * 2 + 7 * scale;
  const png = new PNG({ width, height });
  png.data.fill(255);
  let cursor = margin;
  for (const char of word) {
    const rows = FONT[char];
    if (!rows) continue;
    rows.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell !== "#") return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = (margin + y * scale + dy) * width + cursor + x * scale + dx;
            const offset = px * 4;
            png.data[offset] = 0;
            png.data[offset + 1] = 0;
            png.data[offset + 2] = 0;
            png.data[offset + 3] = 255;
          }
        }
      });
    });
    cursor += letterW + gap;
  }
  return PNG.sync.write(png);
}

describe("ocr pixels", () => {
  it.skipIf(!haveData)("reads a word painted into a PNG", async () => {
    const png = textPng("HELLO");
    const blank = new PNG({ width: 80, height: 40 });
    blank.data.fill(255);
    const blankPng = PNG.sync.write(blank);
    expect(imageVariance(new Uint8Array(png))).toBeGreaterThan(40);
    expect(imageVariance(new Uint8Array(blankPng))).toBeLessThan(40);
    const cache = stagedData();
    const text = await recognizeImage(new Uint8Array(png), cache, {
      tessedit_pageseg_mode: "7",
    }, "eng");
    const empty = await recognizeImage(new Uint8Array(blankPng), cache, {
      tessedit_pageseg_mode: "7",
    }, "eng");
    expect(text.toUpperCase()).toContain("HELLO");
    expect(empty.toUpperCase()).not.toContain("HELLO");
  }, 120_000);

  // tesseract.js 7 applies a big-endian ("MM") EXIF orientation by itself but reads a little-endian ("II") one sideways,
  // and cameras write both. Checked 2026-10-04 on orientation 6.
  it.skipIf(!haveData).each([
    ["big-endian", [0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], [0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]],
    ["little-endian", [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0], [1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]],
  ])("reads a JPEG stored sideways with a %s EXIF tag as upright text", async (_name, header, ifd) => {
    // The display is the word. Orientation 6 stores it rotated a quarter turn, so the file holds S(x, y) = D(w - 1 - y, x).
    const display = PNG.sync.read(textPng("HELLO"));
    const { width: dw, height: dh } = display;
    const stored = Buffer.alloc(dw * dh * 4);
    for (let y = 0; y < dw; y += 1)
      for (let x = 0; x < dh; x += 1) {
        const from = (x * dw + (dw - 1 - y)) * 4;
        display.data.copy(stored, (y * dh + x) * 4, from, from + 4);
      }
    const plain = jpeg.encode({ data: stored, width: dh, height: dw }, 95).data;
    const exif = Buffer.concat([Buffer.from("Exif\0\0", "binary"), Buffer.from(header), Buffer.from(ifd)]);
    const app1 = Buffer.from([0xff, 0xe1, 0, exif.length + 2]);
    // After the JFIF block, as a camera writes it.
    const at = 4 + ((plain[4]! << 8) | plain[5]!);
    const tagged = Buffer.concat([plain.subarray(0, at), app1, exif, plain.subarray(at)]);
    const cache = stagedData();
    const text = await recognizeImage(new Uint8Array(tagged), cache, { tessedit_pageseg_mode: "7" }, "eng");
    expect(text.toUpperCase()).toContain("HELLO");
  }, 120_000);

  it("needs the downloaded language data: with none it fails by name and starts no worker", async () => {
    const empty = mkdtempSync(join(tmpdir(), "pyxis-tess-"));
    await expect(recognizeImage(new Uint8Array(textPng("HELLO")), empty, undefined, "eng")).rejects.toThrow("ocr-data-missing");
    // A file the old tesseract.js cache would have left beside the pinned folder is not data.
    writeFileSync(join(empty, "eng.traineddata"), "cached by an earlier build");
    await expect(recognizeImage(new Uint8Array(textPng("HELLO")), empty, undefined, "eng")).rejects.toThrow("ocr-data-missing");
  });

  it("refuses a language file that is not the pinned one", async () => {
    const tess = mkdtempSync(join(tmpdir(), "pyxis-tess-"));
    mkdirSync(ocrDataDir(tess), { recursive: true });
    writeFileSync(join(ocrDataDir(tess), "eng.traineddata"), "not the pinned file");
    await expect(recognizeImage(new Uint8Array(textPng("HELLO")), tess, undefined, "eng")).rejects.toThrow("ocr-data-integrity");
  });

  it.skipIf(!haveData)("checks the files again on every use, so a file changed after one run is refused on the next", async () => {
    const tess = stagedData();
    const png = new Uint8Array(textPng("HELLO"));
    expect((await recognizeImage(png, tess, { tessedit_pageseg_mode: "7" }, "eng")).toUpperCase()).toContain("HELLO");
    const file = join(ocrDataDir(tess), "eng.traineddata");
    const bytes = readFileSync(file);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    writeFileSync(file, bytes);
    await expect(recognizeImage(png, tess, { tessedit_pageseg_mode: "7" }, "eng")).rejects.toThrow("ocr-data-integrity");
  }, 120_000);
});
