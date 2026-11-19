import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write";
import { readCapped } from "../sources/capped-body";
import { adoptModelFile, modelFileSchema } from "./model-roles";

/**
 * The model file (`resources/model-roles.json`) is also fetched from the project's repository, so a new model reaches
 * students between releases. The request goes to raw.githubusercontent.com with no query string and no header of
 * Pyxis's own, so it carries nothing about the student. The newest valid copy of the shipped file and the downloaded
 * one is the one in use, and the downloaded one is kept in the app's data folder.
 */

const DAY = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 256 * 1024;
export const MODEL_FILE_NAME = "model-roles.json";

/** A pre-release build (`0.5.0-dev.13`) follows `next`, where the next version is built. A release follows `main`. */
export function modelFileBranch(version: string): "main" | "next" {
  return /^[^+]*-/.test(version) ? "next" : "main";
}

export function modelFileUrl(repository: string, version: string): string {
  return `https://raw.githubusercontent.com/${repository}/${modelFileBranch(version)}/resources/${MODEL_FILE_NAME}`;
}

type Stored = { checkedAt: number; file?: unknown };

function readStored(path: string): Stored | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Stored;
    return Number.isFinite(value.checkedAt) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function download(url: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok || !response.body) throw new Error("model-file-fetch");
  const bytes = await readCapped(response.body, MAX_BYTES, () => new Error("model-file-size"));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type ModelFileSync = {
  /** The app's data folder, where the downloaded copy is kept. Without one nothing is stored. */
  dir?: string;
  repository: string;
  version: string;
  /** Where to ask. `null` takes the network away: only the stored copy is read. */
  fetch: typeof fetch | null;
  /** Replaces the repository's URL, for tests that serve the file from a local server. */
  url?: string;
  now?: () => number;
  /** A newer copy than the one in use was taken, so the automatic choice should be worked out again. */
  onAdopted?: () => void;
};

/**
 * Reads the stored copy at once, then asks the repository for a newer one unless the last ask was less than a day ago.
 * Every failure (offline, a file that does not validate, one that is not newer) leaves the copy in use as it was, and
 * the start never waits for the answer.
 */
export async function syncModelFile(options: ModelFileSync): Promise<void> {
  const path = options.dir ? join(options.dir, MODEL_FILE_NAME) : undefined;
  const stored = path ? readStored(path) : undefined;
  if (stored?.file !== undefined) adoptModelFile(stored.file);
  if (!options.fetch) return;
  const now = (options.now ?? Date.now)();
  // A clock set back counts as a day that has passed.
  if (stored && now >= stored.checkedAt && now - stored.checkedAt < DAY) return;
  let keep = stored?.file;
  try {
    const raw = await download(options.url ?? modelFileUrl(options.repository, options.version), options.fetch);
    const parsed = modelFileSchema.safeParse(raw);
    if (parsed.success) {
      keep = parsed.data;
      if (adoptModelFile(parsed.data)) options.onAdopted?.();
    }
  } catch {
    // Offline or refused: the copy in use stays, and the next try is a day away.
  }
  if (path) {
    try {
      writeFileAtomic(path, JSON.stringify({ checkedAt: now, ...(keep !== undefined ? { file: keep } : {}) }));
    } catch {
      // A folder that cannot be written only means the next start asks again.
    }
  }
}
