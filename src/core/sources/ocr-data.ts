import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sha256 } from "./quality";

/**
 * Local OCR language data (SRC-04, ASK-04). Pyxis never lets tesseract.js fetch it: the files are the Apache-2.0
 * `tessdata_fast` models of the official tesseract-ocr project, pinned to one commit. They are downloaded only by
 * the explicit `ocr-data-download` job after the student agrees, and every OCR run reads them back and checks them
 * against these hashes first. Sizes and hashes were taken from that commit's git tree and the downloaded bytes.
 */
export const OCR_DATA_REVISION = "87416418657359cb625c412a48b6e1d6d41c29bd";
export const OCR_DATA_BASE = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${OCR_DATA_REVISION}/`;
export type OcrDataFile = { sha256: string; size: number };
export const OCR_DATA_FILES: Record<string, OcrDataFile> = {
  eng: {
    sha256: "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    size: 4113088,
  },
  ita: {
    sha256: "b8f89e1e785118dac4d51ae042c029a64edb5c3ee42ef73027a6d412748d8827",
    size: 2701314,
  },
};
export const OCR_LANGUAGES = Object.keys(OCR_DATA_FILES);
export const OCR_DATA_BYTES = Object.values(OCR_DATA_FILES).reduce(
  (sum, file) => sum + file.size,
  0,
);

const CONSENT_KEY = "ocr.consent";

/** Folder of this pin under `runtimes/tesseract`. Files an older build cached beside it are never read. */
export function ocrDataDir(tess: string): string {
  return join(tess, `tessdata_fast-${OCR_DATA_REVISION.slice(0, 12)}`);
}

/**
 * Where one OCR run keeps its copy of the language files: a folder of its own under the workspace, never the OS temp
 * folder. The parent of the extract worker names it and removes it when the worker ends, however it ends, because a
 * cancelled or timed-out worker is terminated before its own cleanup can run.
 */
export function ocrScratchRoot(tess: string): string {
  return join(tess, "scratch");
}
const processStart = Date.now();

/**
 * Removes scratch folders left by an earlier process (a crash, or a quit mid-OCR). Only this workspace's own scratch
 * root is looked at, and only entries older than this process, so a run that is under way is never touched. A scratch
 * root or entry that is a symlink (or anything but a real folder or file) is skipped, never followed, so a planted link
 * cannot make the sweep delete data outside the workspace.
 */
export function sweepStaleOcrScratch(tess: string): void {
  const root = ocrScratchRoot(tess);
  let names: string[];
  try {
    if (!lstatSync(root).isDirectory()) return;
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      // rmSync removes a symlink entry itself without following it, but an unexpected link is left for the student.
      if (!stat.isSymbolicLink() && stat.mtimeMs < processStart) rmSync(path, { recursive: true, force: true });
    } catch {
      // Left for the next start.
    }
  }
}

/**
 * Creates one run's scratch folder. A scratch root that is a symlink or not a folder is refused (`ocr-scratch-unsafe`)
 * rather than written through, because a recursive `mkdir` would follow the link and put the language files outside the
 * workspace. Only the root is checked; the workspace folders above it are the student's own choice.
 * ponytail: a check then a mkdir is not atomic, so a link swapped in between is not caught; that needs local write
 * access to the workspace, which is already the trust boundary. Upgrade path: open the root with O_NOFOLLOW|O_DIRECTORY.
 */
export async function createOcrScratch(tess: string, scratch: string): Promise<void> {
  const root = ocrScratchRoot(tess);
  let stat = await lstat(root).catch(() => undefined);
  if (!stat) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    stat = await lstat(root);
  }
  if (!stat.isDirectory()) throw new Error("ocr-scratch-unsafe");
  await mkdir(scratch, { mode: 0o700 });
}

export function setOcrConsent(db: Database.Database, accepted: boolean): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(CONSENT_KEY, JSON.stringify(accepted), Date.now());
}

export function ocrConsent(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT value_json FROM settings WHERE key = ?`)
    .get(CONSENT_KEY) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) === true : false;
}

type Problem = "missing" | "integrity";

async function check(
  tess: string,
  lang: string,
  files: Record<string, OcrDataFile>,
): Promise<Uint8Array | Problem> {
  const pinned = files[lang];
  if (!pinned) throw new Error("ocr-language-unsupported");
  let bytes: Buffer;
  try {
    bytes = await readFile(join(ocrDataDir(tess), `${lang}.traineddata`));
  } catch {
    return "missing";
  }
  return bytes.length === pinned.size && sha256(bytes) === pinned.sha256
    ? bytes
    : "integrity";
}

/**
 * The verified bytes of each language, read now. A file that is absent is `ocr-data-missing`, and one that is there
 * but is not the pinned file is `ocr-data-integrity`. Nothing is downloaded here.
 */
export async function readVerifiedOcrData(
  tess: string,
  langs: string[],
  files: Record<string, OcrDataFile> = OCR_DATA_FILES,
): Promise<Array<{ code: string; data: Uint8Array }>> {
  const out: Array<{ code: string; data: Uint8Array }> = [];
  let problem: Problem | undefined;
  for (const code of langs) {
    const result = await check(tess, code, files);
    if (typeof result === "string")
      problem = problem === "integrity" ? problem : result;
    else out.push({ code, data: result });
  }
  if (problem) throw new Error(`ocr-data-${problem}`);
  return out;
}

export type OcrDataState = {
  state: "ready" | "missing" | "integrity";
  totalBytes: number;
};

/** Disk truth for the status request: every language present and matching its pin. */
export async function ocrDataStatus(
  tess: string,
  files: Record<string, OcrDataFile> = OCR_DATA_FILES,
): Promise<OcrDataState> {
  const totalBytes = Object.values(files).reduce(
    (sum, file) => sum + file.size,
    0,
  );
  try {
    await readVerifiedOcrData(tess, Object.keys(files), files);
    return { state: "ready", totalBytes };
  } catch (error) {
    return {
      state:
        error instanceof Error && error.message === "ocr-data-integrity"
          ? "integrity"
          : "missing",
      totalBytes,
    };
  }
}

/**
 * Downloads one language file into this pin's folder unless it is already there and verified. The body is read up to the
 * pinned size and no further, hashed, and only then renamed into place, so a short, long or altered file is never kept.
 * Errors: `ocr-data-offline` (no connection), `ocr-data-download` (HTTP error), `ocr-data-too-big`, `ocr-data-integrity`.
 */
export async function downloadOcrLanguage(
  tess: string,
  lang: string,
  signal: AbortSignal,
  options: {
    fetchImpl?: typeof fetch;
    base?: string;
    files?: Record<string, OcrDataFile>;
  } = {},
): Promise<void> {
  const files = options.files ?? OCR_DATA_FILES;
  const pinned = files[lang];
  if (!pinned) throw new Error("ocr-language-unsupported");
  signal.throwIfAborted();
  if (typeof (await check(tess, lang, files)) !== "string") return;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${options.base ?? OCR_DATA_BASE}${lang}.traineddata`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      },
    );
  } catch (error) {
    signal.throwIfAborted();
    throw new Error("ocr-data-offline", { cause: error });
  }
  if (!response.ok || !response.body) throw new Error("ocr-data-download");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > pinned.size) throw new Error("ocr-data-too-big");
      chunks.push(chunk);
    }
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.message === "ocr-data-too-big")
    )
      throw error;
    throw new Error("ocr-data-offline", { cause: error });
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== pinned.size || sha256(bytes) !== pinned.sha256)
    throw new Error("ocr-data-integrity");
  signal.throwIfAborted();
  const dir = ocrDataDir(tess);
  await mkdir(dir, { recursive: true });
  const staging = join(dir, `${lang}.traineddata.${randomUUID()}.tmp`);
  try {
    await writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    await rename(staging, join(dir, `${lang}.traineddata`));
  } finally {
    await rm(staging, { force: true });
  }
}
