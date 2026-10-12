import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fetchPublicResponse } from "./link";

/** The free PoliTost smartbooks. The site is static: a catalog plus one package per book version. */
export const BOOKS_ORIGIN = "https://books.politost.it";
const CATALOG_URL = `${BOOKS_ORIGIN}/catalog.json`;
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

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

/** Reads bytes from the books site, refusing anything bigger than `max`. */
export type BooksTransport = (
  url: string,
  max: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;

/** The production transport: every resolved address is checked as public and the socket is pinned to it. */
export const httpsTransport: BooksTransport = async (url, max, signal) => {
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

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Fetches the catalog. A malformed entry is left out rather than hiding every other book. */
export async function fetchCatalog(
  transport: BooksTransport,
  signal?: AbortSignal,
): Promise<CatalogBook[]> {
  let bytes: Uint8Array;
  try {
    bytes = await transport(CATALOG_URL, MAX_CATALOG_BYTES, withTimeout(signal));
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
): Promise<Uint8Array> {
  const url = packageUrl(book);
  if (!url) throw new Error("books-catalog");
  if (book.bytes > maxBytes) throw new Error("source-too-big");
  let bytes: Uint8Array;
  try {
    bytes = await transport(url, book.bytes, withTimeout(signal));
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.message === "books-too-big")
      throw new Error("books-integrity");
    throw new Error("books-offline");
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== book.bytes || sha !== book.sha256)
    throw new Error("books-integrity");
  return bytes;
}
