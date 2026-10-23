import { createRequire } from "node:module";
import { withOcrWorker } from "./recognize";
import type { OcrPage } from "./ocr";

/** The scale the window used to draw pages for OCR before core took the scan over, so pages read the same. */
const PAGE_SCALE = 1.5;
/**
 * A page larger than this is drawn smaller, so a poster-sized page cannot take gigabytes of pixels. An A4 page at the
 * normal scale is about 1.6 million.
 */
export const MAX_PAGE_PIXELS = 16_000_000;

/** The scale that draws a page of `width` x `height` points at the normal size, or smaller to stay in the pixel cap. */
export function pageScale(width: number, height: number): number {
  const area = width * height;
  if (!(area > 0)) return PAGE_SCALE;
  return Math.min(PAGE_SCALE, Math.sqrt(MAX_PAGE_PIXELS / area));
}

type Canvas = {
  width: number;
  height: number;
  getContext(kind: "2d"): unknown;
  toBuffer(mime: "image/png"): Buffer;
};
type CanvasModule = {
  createCanvas(width: number, height: number): Canvas;
  DOMMatrix: unknown;
  Path2D: unknown;
  ImageData: unknown;
};

/**
 * Draws `pages` of a PDF and reads each with local OCR, in one worker thread. Pages past the end are skipped, and the
 * page count comes back so the caller learns it on its first batch. Runs in the extract worker; core's main thread
 * keeps the canvas addon loaded (see `worker-client.ts`).
 */
export async function ocrPdfPages(
  bytes: Uint8Array,
  pages: number[],
  tess: string,
  scratch?: string,
): Promise<{ count: number; pages: OcrPage[] }> {
  // pdf.js' modern build draws through these in Node; its legacy build would set them, but it loads the addon eagerly.
  const canvas = createRequire(import.meta.url)("@napi-rs/canvas") as CanvasModule;
  const scope = globalThis as Record<string, unknown>;
  scope.DOMMatrix ??= canvas.DOMMatrix;
  scope.Path2D ??= canvas.Path2D;
  scope.ImageData ??= canvas.ImageData;
  const { getDocument } = await import("pdfjs-dist");
  const doc = await getDocument({
    data: bytes,
    disableWorker: true,
    isEvalSupported: false,
    // No font faces in Node: glyphs are drawn as paths, which is what OCR needs.
    disableFontFace: true,
  } as Parameters<typeof getDocument>[0]).promise.catch((error: unknown) => {
    // A locked scan was opened with its password at import, and Pyxis never keeps the password.
    if (error instanceof Error && error.name === "PasswordException") throw new Error("pdf-password-required");
    throw error;
  });
  try {
    const wanted = pages.filter((page) => page >= 1 && page <= doc.numPages);
    const read = wanted.length
      ? await withOcrWorker(
          tess,
          async (recognize) => {
            const out: OcrPage[] = [];
            for (const number of wanted) {
              const page = await doc.getPage(number);
              try {
                const base = page.getViewport({ scale: 1 });
                const viewport = page.getViewport({ scale: pageScale(base.width, base.height) });
                const drawing = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
                const context = drawing.getContext("2d") as {
                  fillStyle: string;
                  fillRect(x: number, y: number, w: number, h: number): void;
                };
                // A transparent page reads as black to Tesseract.
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, drawing.width, drawing.height);
                await page.render({ canvasContext: context, viewport } as Parameters<typeof page.render>[0]).promise;
                out.push({ page: number, text: await recognize(drawing.toBuffer("image/png")) });
              } finally {
                // Each page's drawing data stays cached until this; a long book would otherwise hold every page.
                page.cleanup();
              }
            }
            return out;
          },
          { scratch },
        )
      : [];
    return { count: doc.numPages, pages: read };
  } finally {
    await doc.destroy();
  }
}
