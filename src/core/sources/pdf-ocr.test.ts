import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { MAX_PAGE_PIXELS, MAX_PAGE_SIDE, ocrPdfPages, pageScale } from "./pdf-ocr";
import { faxScanPdf } from "./test-pdf";

// Stands in for Tesseract: "reads" each drawn page as the share of its pixels that are dark.
vi.mock("./recognize", () => ({
  withOcrWorker: async <T>(_tess: string, use: (read: (pixels: Uint8Array) => Promise<string>) => Promise<T>) =>
    use(async (pixels) => {
      const { data } = PNG.sync.read(Buffer.from(pixels));
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! < 128) dark += 1;
      return (dark / (data.length / 4)).toFixed(2);
    }),
}));

const drawn = (width: number, height: number) => {
  const scale = pageScale(width, height);
  return { width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
};

it("draws a normal page at 1.5 and shrinks a huge or very thin one within both caps, after rounding", () => {
  // A4 in points.
  expect(pageScale(595, 842)).toBe(1.5);
  for (const [width, height] of [
    [14_400, 14_400],
    [1_000_000_000, 1],
    [1, 1_000_000_000],
    [100_000, 3],
  ] as const) {
    const size = drawn(width, height);
    expect(size.width).toBeLessThanOrEqual(MAX_PAGE_SIDE);
    expect(size.height).toBeLessThanOrEqual(MAX_PAGE_SIDE);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
    expect(size.width).toBeGreaterThan(0);
  }
  // A page with no size keeps the normal scale rather than dividing by zero.
  expect(pageScale(0, 842)).toBe(1.5);
});

// pdf.js decodes fax and JBIG2 images with a WebAssembly module it loads from its own folder. Without it the image is
// skipped and the page reaches OCR blank.
it("draws a fax-encoded scan for OCR instead of a blank page", async () => {
  const read = await ocrPdfPages(faxScanPdf(), [1], "unused");
  expect(read.count).toBe(1);
  // The image covers three quarters of the page.
  expect(Number(read.pages[0]?.text)).toBeGreaterThan(0.7);
});
