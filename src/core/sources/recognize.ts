import { createWorker } from "tesseract.js";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { laplacianVariance } from "./quality";

export async function recognizeImage(
  bytes: Uint8Array,
  cachePath: string,
  parameters?: Record<string, string>,
  langs = "eng+ita",
): Promise<string> {
  const worker = await createWorker(langs, 1, {
    cachePath,
    workerBlobURL: false,
  });
  try {
    await worker.setParameters({
      user_defined_dpi: "300",
      ...parameters,
    });
    const result = await worker.recognize(Buffer.from(bytes));
    return result.data.text.replace(/\s+/g, " ").trim();
  } finally {
    await worker.terminate();
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

/** Decode a photo to grayscale so the blur check sees pixels, not the file name. */
export function grayFromImage(
  bytes: Uint8Array,
  ext: string,
): { gray: Uint8Array; width: number; height: number } | null {
  const lower = ext.toLowerCase();
  if (lower === ".png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    return {
      gray: rgbaToGray(png.data, png.width, png.height),
      width: png.width,
      height: png.height,
    };
  }
  if (lower === ".jpg" || lower === ".jpeg") {
    const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true, formatAsRGBA: true });
    return {
      gray: rgbaToGray(decoded.data, decoded.width, decoded.height),
      width: decoded.width,
      height: decoded.height,
    };
  }
  return null;
}

export function imageVariance(bytes: Uint8Array, ext: string): number | null {
  const image = grayFromImage(bytes, ext);
  if (!image) return null;
  return laplacianVariance(image.gray, image.width, image.height);
}
