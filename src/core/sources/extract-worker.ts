import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { extractByExt } from "./documents";
import { parseSmartbook } from "./smartbook";
import { heicToPng, isHeicExt } from "./heic";
import { imageVariance, recognizeImage } from "./recognize";

const input = workerData as { path: string; ext: string; tess: string; mode?: "quality" | "pixels" };
try {
  const bytes = new Uint8Array(await readFile(input.path));
  if (input.mode === "quality" || input.mode === "pixels") {
    const pixels = isHeicExt(input.ext) ? (await heicToPng(bytes)).png : bytes;
    parentPort?.postMessage({ value: input.mode === "pixels" ? pixels : imageVariance(pixels, isHeicExt(input.ext) ? ".png" : input.ext) });
  } else {
  const value = input.ext === ".ptsb"
    ? { book: parseSmartbook(bytes) }
    : isHeicExt(input.ext)
      // Pixels go to OCR as a bounded PNG; the stored original stays HEIC.
      ? { document: { pages: [{ text: await recognizeImage((await heicToPng(bytes)).png, input.tess), locator: { page: 1 }, section: "text" }], scanned: false } }
    : [".png", ".jpg", ".jpeg", ".webp"].includes(input.ext)
      ? { document: { pages: [{ text: await recognizeImage(bytes, input.tess), locator: { page: 1 }, section: "text" }], scanned: false } }
      : { document: await extractByExt(bytes, input.ext) };
  parentPort?.postMessage({ value });
  }
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : "extraction-failed" });
}
