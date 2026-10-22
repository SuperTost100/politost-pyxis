import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fetchPublicResponse } from "./public-fetch";
import { sha256 } from "./quality";

/** The free PoliTost smartbooks. The site is static: a catalog plus one package per book version. */
const BOOKS_ORIGIN = "https://books.politost.it";
const CATALOG_URL = `${BOOKS_ORIGIN}/catalog.json`;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/** How long a request may wait for its next bytes. A slow download that keeps receiving is not cut off. */
const IDLE_MS = 30_000;

const bookSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/),
  title: z.string().min(1).max(300),
  subject: z.string().max(200).default(""),
  authors: z.array(z.string().max(200)).max(50).default([]),
  version: z.string().min(1).max(40),
  chapters: z.number().int().nonnegative(),
  package: z.string().min(1).max(500),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CatalogBook = z.infer<typeof bookSchema>;

/** Reads bytes from the books site, refusing anything bigger than `max`. `progress` is called as each part arrives. */
export type BooksTransport = (
  url: string,
  max: number,
  signal: AbortSignal,
  progress?: () => void,
) => Promise<Uint8Array>;

/** The production transport: every resolved address is checked as public and the socket is pinned to it. */
export const httpsTransport: BooksTransport = async (url, max, signal, progress) => {
  const { response, agent } = await fetchPublicResponse(url, {
    redirect: "manual",
    signal,
  });
  try {
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("books-offline");
    }
    if (Number(response.headers.get("content-length")) > max) {
      await response.body.cancel();
      throw new Error("books-too-big");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      progress?.();
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error("books-too-big");
      }
      chunks.push(part.value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    await agent.close();
  }
};

/** Tests serve the site from a folder laid out like books.politost.it. */
export function folderTransport(dir: string): BooksTransport {
  return async (url, max) => {
    const path = new URL(url).pathname.replace(/^\/+/, "");
    const bytes = readFileSync(join(dir, ...path.split("/")));
    if (bytes.byteLength > max) throw new Error("books-too-big");
    return new Uint8Array(bytes);
  };
}

/**
 * Reads `url` through `transport`, giving up when no bytes arrive for `idleMs`. The wait restarts with each part, so a
 * large book on a slow connection can take as long as it needs.
 */
async function readIdle(
  transport: BooksTransport,
  url: string,
  max: number,
  idleMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => idle.abort(new DOMException("No data arrived in time", "TimeoutError")),
      idleMs,
    );
  };
  restart();
  try {
    return await transport(
      url,
      max,
      signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
      restart,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches the catalog. A malformed entry is left out rather than hiding every other book. */
export async function fetchCatalog(
  transport: BooksTransport,
  signal?: AbortSignal,
  idleMs = IDLE_MS,
): Promise<CatalogBook[]> {
  let bytes: Uint8Array;
  try {
    bytes = await readIdle(transport, CATALOG_URL, MAX_CATALOG_BYTES, idleMs, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.message === "books-too-big")
      throw new Error("books-catalog");
    throw new Error("books-offline");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("books-catalog");
  }
  const shape = z
    .object({ catalogVersion: z.literal(1), books: z.array(z.unknown()).max(2000) })
    .safeParse(raw);
  if (!shape.success) throw new Error("books-catalog");
  return shape.data.books.flatMap((entry) => {
    const book = bookSchema.safeParse(entry);
    return book.success && packageUrl(book.data) ? [book.data] : [];
  });
}

/** The package address, which must stay on the books site. */
export function packageUrl(book: CatalogBook): string | null {
  try {
    const url = new URL(book.package, `${BOOKS_ORIGIN}/`);
    return url.origin === BOOKS_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
}

/** Downloads a book and checks it byte for byte against the size and SHA-256 the catalog lists. */
export async function downloadBook(
  book: CatalogBook,
  transport: BooksTransport,
  maxBytes: number,
  signal?: AbortSignal,
  idleMs = IDLE_MS,
): Promise<Uint8Array> {
  const url = packageUrl(book);
  if (!url) throw new Error("books-catalog");
  if (book.bytes > maxBytes) throw new Error("source-too-big");
  let bytes: Uint8Array;
  try {
    bytes = await readIdle(transport, url, book.bytes, idleMs, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.message === "books-too-big")
      throw new Error("books-integrity");
    throw new Error("books-offline");
  }
  const sha = sha256(bytes);
  if (bytes.byteLength !== book.bytes || sha !== book.sha256)
    throw new Error("books-integrity");
  return bytes;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether a version is semver, as the books repository requires of every book. */
export function isSemverVersion(version: string): boolean {
  return SEMVER.test(version);
}

/**
 * Semver precedence as the books repository defines it (`scripts/books.ts` there): negative when `a` is older. A
 * prerelease sorts before its release. Null when either side is not semver, so the caller decides another way.
 */
export function compareBookVersions(a: string, b: string): number | null {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) return null;
  const core =
    Number(left[1]) - Number(right[1]) ||
    Number(left[2]) - Number(right[2]) ||
    Number(left[3]) - Number(right[3]);
  if (core) return Math.sign(core);
  const [aPre, bPre] = [left[4], right[4]];
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  const aParts = aPre.split(".");
  const bParts = bPre.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const x = aParts[i];
    const y = bParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    } else if (xNum !== yNum) return xNum ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Whether the catalog's entry is a newer version of the copy the student has. The same package is never newer. Two
 * semver versions compare by precedence, so the catalog going back to an older version offers nothing. Otherwise a
 * different version string is newer, since the catalog only ever lists a book's current version.
 */
export function isNewerBook(
  book: Pick<CatalogBook, "version" | "sha256">,
  installed: { version: string | null; sha: string | null },
): boolean {
  if (installed.sha === book.sha256) return false;
  if (installed.version == null) return false;
  const order = compareBookVersions(book.version, installed.version);
  return order == null ? book.version !== installed.version : order > 0;
}
