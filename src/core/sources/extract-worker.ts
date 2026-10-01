import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { extractByExt } from "./documents";
import { parseSmartbook } from "./smartbook";
import { recognizeImage } from "./recognize";

const input = workerData as { path: string; ext: string; tess: string };
try {
  const bytes = new Uint8Array(await readFile(input.path));
  const value = input.ext === ".ptsb"
    ? { book: parseSmartbook(bytes) }
    : [".png", ".jpg", ".jpeg", ".webp"].includes(input.ext)
      ? { document: { pages: [{ text: await recognizeImage(bytes, input.tess), locator: { page: 1 }, section: "text" }], scanned: false } }
      : { document: await extractByExt(bytes, input.ext) };
  parentPort?.postMessage({ value });
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : "extraction-failed" });
}
