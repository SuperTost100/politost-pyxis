import { parentPort, workerData } from "node:worker_threads";
import { readBounded } from "./bounded-read";
import { extractByExt } from "./documents";
import { parseSmartbook } from "./smartbook";
import { heicToPng, isHeicExt } from "./heic";
import { hashFiles, sha256 } from "./quality";
import { imageVariance, recognizeImage } from "./recognize";
import { normalizeForVision } from "./vision-image";
import { maxSourceBytes } from "../../shared/source-types";

type Input = {
  path: string;
  ext: string;
  tess: string;
  /** `extract` is a document read for a chat attachment: the same extractors as an import, behind the decode gate. */
  mode?: "quality" | "pixels" | "vision" | "hash" | "ocr" | "extract";
  /** Files to hash in `hash` mode. */
  paths?: string[];
  /** Largest file the worker will read, by extension when unset. Checked from the size, before any buffer exists. */
  maxBytes?: number;
  /**
   * `ocr` mode: pixels already decoded by an earlier call (a HEIC's PNG), read instead of `path`, so the picture is
   * not decoded twice. They come from this app's own decoder, which bounds their size.
   * `extract` mode: the bytes core already read within its cap, so the stored file and the extracted text are the same bytes.
   */
  bytes?: Uint8Array;
  /** The folder this run's OCR language files go in. The caller names it and removes it when the worker ends. */
  scratch?: string;
};
const input = workerData as Input;
const ocr = (pixels: Uint8Array) => recognizeImage(pixels, input.tess, undefined, undefined, input.scratch);

try {
  if (input.mode === "hash") {
    parentPort?.postMessage({ value: await hashFiles(input.paths ?? [], input.maxBytes ?? 0) });
  } else {
    const bytes = (input.mode === "ocr" || input.mode === "extract") && input.bytes
      ? input.bytes
      : await readBounded(input.path, input.maxBytes ?? maxSourceBytes(input.ext));
    if (input.mode === "ocr") {
      // Local OCR for chat and the direct image import: the one recognizer, turned upright inside it, off the core thread.
      const pixels = !input.bytes && isHeicExt(input.ext) ? (await heicToPng(bytes)).png : bytes;
      parentPort?.postMessage({ value: await ocr(pixels) });
    } else if (input.mode === "vision") {
      // A HEIC becomes a bounded PNG first. Both then fit the provider limits in one place.
      parentPort?.postMessage({ value: normalizeForVision(isHeicExt(input.ext) ? (await heicToPng(bytes)).png : bytes) });
    } else if (input.mode === "quality" || input.mode === "pixels") {
      const pixels = isHeicExt(input.ext) ? (await heicToPng(bytes)).png : bytes;
      parentPort?.postMessage({
        value:
          input.mode === "pixels"
            ? pixels
            : { sha: sha256(bytes), variance: imageVariance(pixels) },
      });
    } else {
      const value = input.ext === ".ptsb"
        ? { book: parseSmartbook(bytes) }
        : isHeicExt(input.ext)
          // Pixels go to OCR as a bounded PNG; the stored original stays HEIC.
          ? { document: { pages: [{ text: await ocr((await heicToPng(bytes)).png), locator: { page: 1 }, section: "text" }], scanned: false, extractor: { path: "ocr" as const } } }
        : [".png", ".jpg", ".jpeg", ".webp"].includes(input.ext)
          ? { document: { pages: [{ text: await ocr(bytes), locator: { page: 1 }, section: "text" }], scanned: false, extractor: { path: "ocr" as const } } }
          : { document: await extractByExt(bytes, input.ext) };
      parentPort?.postMessage({ value });
    }
  }
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : "extraction-failed" });
}
