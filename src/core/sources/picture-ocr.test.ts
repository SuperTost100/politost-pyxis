import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { ocrScanPictures } from "./picture-ocr";
import { docxOf, pptxOf } from "./test-office";

// Stands in for Tesseract: "reads" each picture as its width, so the test sees which picture went where.
vi.mock("./recognize", () => ({
  withOcrWorker: async <T>(_tess: string, use: (read: (pixels: Uint8Array) => Promise<string>) => Promise<T>) =>
    use(async (pixels) => `larga ${PNG.sync.read(Buffer.from(pixels)).width}`),
}));

const png = (width: number) => PNG.sync.write(new PNG({ width, height: 1 }));

it("reads the pictures of a Word file as pages in reading order, skips pages past the end, and reads a broken one as blank", async () => {
  const docx = docxOf([png(3), "Didascalia", new TextEncoder().encode("not a picture"), png(5)]);
  const read = await ocrScanPictures(docx, ".docx", [1, 2, 3, 4], "unused");
  expect(read).toEqual({
    count: 3,
    pages: [
      { page: 1, section: "picture 1", text: "larga 3" },
      { page: 2, section: "picture 2", text: "" },
      { page: 3, section: "picture 3", text: "larga 5" },
    ],
  });
});

it("reads the pictures of the slides of a presentation that have no text of their own, named by their slide", async () => {
  const deck = pptxOf([{ pictures: [png(2)] }, { text: "Una slide con il suo testo, lunga abbastanza", pictures: [png(9)] }, { pictures: [png(4), png(6)] }]);
  const read = await ocrScanPictures(deck, ".pptx", [2, 3], "unused");
  expect(read).toEqual({
    count: 3,
    pages: [
      { page: 2, section: "slide 3", text: "larga 4" },
      { page: 3, section: "slide 3", text: "larga 6" },
    ],
  });
});
