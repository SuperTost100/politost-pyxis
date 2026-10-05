import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { downloadModel } from "../src/core/sources/embed";
import { OCR_DATA_BASE, OCR_DATA_FILES } from "../src/core/sources/ocr-data";

// CI uses the same pinned bytes as production. Files stay outside the repository.
async function pinned(file: string, url: string, sha256: string, size: number) {
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  try {
    const bytes = await readFile(file);
    if (bytes.length === size && digest(bytes) === sha256) return;
  } catch { /* Download a missing fixture. */ }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${file}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== size || digest(bytes) !== sha256) throw new Error(`Fixture integrity: ${file}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.part`, bytes);
  await rename(`${file}.part`, file);
}
const manifest = JSON.parse(await readFile("resources/pyodide-manifest.json", "utf8")) as {
  baseURL: string; files: Array<{name: string; sha256: string; size: number}>;
};
for (const file of manifest.files) {
  await pinned(join(".tmp/pyodide", file.name), new URL(file.name, manifest.baseURL).href, file.sha256, file.size);
}
for (const [language, file] of Object.entries(OCR_DATA_FILES)) {
  await pinned(join(".tmp/tessdata-fast", `${language}.traineddata`), `${OCR_DATA_BASE}${language}.traineddata`, file.sha256, file.size);
}
await downloadModel(".tmp/e5", AbortSignal.timeout(300_000));
console.log("Pinned Python, OCR and embedding fixtures verified.");
