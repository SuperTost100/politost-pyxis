import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { imageVariance, recognizeImage } from "./recognize";

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
  it("reads a word painted into a PNG", async () => {
    const png = textPng("HELLO");
    const blank = new PNG({ width: 80, height: 40 });
    blank.data.fill(255);
    const blankPng = PNG.sync.write(blank);
    expect(imageVariance(new Uint8Array(png), ".png")).toBeGreaterThan(40);
    expect(imageVariance(new Uint8Array(blankPng), ".png")).toBeLessThan(40);
    const cache = mkdtempSync(join(tmpdir(), "pyxis-tess-"));
    const text = await recognizeImage(new Uint8Array(png), cache, {
      tessedit_pageseg_mode: "7",
    }, "eng");
    const empty = await recognizeImage(new Uint8Array(blankPng), cache, {
      tessedit_pageseg_mode: "7",
    }, "eng");
    expect(text.toUpperCase()).toContain("HELLO");
    expect(empty.toUpperCase()).not.toContain("HELLO");
  }, 120_000);
});
