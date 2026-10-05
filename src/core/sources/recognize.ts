import { rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createWorker } from "tesseract.js";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { laplacianVariance } from "./quality";
import { createOcrScratch, ocrScratchRoot, readVerifiedOcrData } from "./ocr-data";
import { assertDecodable, MAX_DECODE_PIXELS, sniffImage, uprightForOcr } from "./vision-image";

/**
 * Local OCR. It never touches the network: the language files come from `tess` (see `ocr-data.ts`), are checked against
 * their pinned hashes on every call, and are handed to tesseract.js as a private local folder holding exactly those
 * bytes, so no CDN default, cache or fallback fetch can run. Errors: `ocr-data-missing`, `ocr-data-integrity` (the student
 * downloads or repairs the data first), and the `vision-image-*` header refusals.
 */
export async function recognizeImage(
  bytes: Uint8Array,
  tess: string,
  parameters?: Record<string, string>,
  langs = "eng+ita",
  /** The folder for this run's language files. Its owner removes it too if this run is cut short. */
  scratch = join(ocrScratchRoot(tess), randomUUID()),
): Promise<string> {
  // The recognizer decodes the whole picture, so the header is checked first, as for every other decode. A type this
  // check cannot size (a TIFF or BMP under a .png name, say) is refused too, not handed on with no pixel bound.
  const mime = sniffImage(bytes);
  if (!mime) throw new Error("vision-image-unsupported");
  assertDecodable(bytes, mime);
  const pixels = uprightForOcr(bytes);
  const data = await readVerifiedOcrData(tess, langs.split("+"));
  const langPath = scratch;
  await createOcrScratch(tess, langPath);
  try {
    for (const file of data) await writeFile(join(langPath, `${file.code}.traineddata`), file.data, { mode: 0o600 });
    const worker = await createWorker(langs, 1, {
      langPath,
      cacheMethod: "none",
      gzip: false,
      workerBlobURL: false,
    });
    try {
      await worker.setParameters({
        user_defined_dpi: "300",
        ...parameters,
      });
      const result = await worker.recognize(Buffer.from(pixels));
      return result.data.text.replace(/\s+/g, " ").trim();
    } finally {
      await worker.terminate();
    }
  } finally {
    await rm(langPath, { recursive: true, force: true });
  }
}

function rgbaToGray(data: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i += 1) {
    const offset = i * 4;
    gray[i] = Math.round(
      0.299 * (data[offset] ?? 0) +
        0.587 * (data[offset + 1] ?? 0) +
        0.114 * (data[offset + 2] ?? 0),
    );
  }
  return gray;
}

/**
 * Decode a photo to grayscale so the blur check sees pixels, not the file name. The type comes from the bytes,
 * and the header is checked first, so a tiny file that declares a huge or unreadable image is refused before a decode.
 * WebP has no decoder here and gives null.
 */
export function grayFromImage(
  bytes: Uint8Array,
): { gray: Uint8Array; width: number; height: number } | null {
  const mime = sniffImage(bytes);
  if (mime !== "image/png" && mime !== "image/jpeg") return null;
  assertDecodable(bytes, mime);
  if (mime === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return {
      gray: rgbaToGray(png.data, png.width, png.height),
      width: png.width,
      height: png.height,
    };
  }
  const decoded = jpeg.decode(Buffer.from(bytes), {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: MAX_DECODE_PIXELS / 1e6,
    maxMemoryUsageInMB: 768,
  });
  return {
    gray: rgbaToGray(decoded.data, decoded.width, decoded.height),
    width: decoded.width,
    height: decoded.height,
  };
}

/** Blur check that also sees HEIC, through the same bounded PNG the OCR gets. */
export function imageVariance(bytes: Uint8Array): number | null {
  const image = grayFromImage(bytes);
  if (!image) return null;
  return laplacianVariance(image.gray, image.width, image.height);
}
