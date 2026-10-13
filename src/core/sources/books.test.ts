import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  downloadBook,
  fetchCatalog,
  packageUrl,
  type BooksTransport,
  type CatalogBook,
} from "./books";

const pkg = new TextEncoder().encode("PK fake smartbook");
const sha = createHash("sha256").update(pkg).digest("hex");
const book: CatalogBook = {
  id: "esempio",
  title: "Guida di esempio",
  subject: "Esempio",
  authors: ["PoliTost"],
  version: "1.0.0",
  chapters: 3,
  package: "books/esempio@1.0.0.ptsb",
  bytes: pkg.byteLength,
  sha256: sha,
};

function site(files: Record<string, Uint8Array | string>): BooksTransport {
  return async (url, max) => {
    const file = files[new URL(url).pathname];
    if (file === undefined) throw new Error("404");
    const bytes = typeof file === "string" ? new TextEncoder().encode(file) : file;
    if (bytes.byteLength > max) throw new Error("books-too-big");
    return bytes;
  };
}
const catalog = (books: unknown[]) =>
  JSON.stringify({ catalogVersion: 1, generatedAt: "2026-10-12", books });

describe("fetchCatalog", () => {
  it("lists valid books and leaves out a malformed or off-site entry", async () => {
    const books = await fetchCatalog(
      site({
        "/catalog.json": catalog([
          book,
          { ...book, id: "rotto", sha256: "nope" },
          { ...book, id: "altrove", package: "https://example.com/x.ptsb" },
        ]),
      }),
    );
    expect(books.map((item) => item.id)).toEqual(["esempio"]);
  });

  it("reports an unreachable site as offline and a broken file as a bad catalog", async () => {
    await expect(fetchCatalog(site({}))).rejects.toThrow("books-offline");
    await expect(
      fetchCatalog(site({ "/catalog.json": "<html>" })),
    ).rejects.toThrow("books-catalog");
    await expect(
      fetchCatalog(site({ "/catalog.json": JSON.stringify({ books: [] }) })),
    ).rejects.toThrow("books-catalog");
  });
});

describe("packageUrl", () => {
  it("resolves a relative package on the books site and refuses anything else", () => {
    expect(packageUrl(book)).toBe(
      "https://books.politost.it/books/esempio@1.0.0.ptsb",
    );
    expect(packageUrl({ ...book, package: "//evil.example/x.ptsb" })).toBeNull();
    expect(
      packageUrl({ ...book, package: "http://books.politost.it/x.ptsb" }),
    ).toBeNull();
  });
});

describe("downloadBook", () => {
  it("returns the package when its size and SHA-256 match the catalog", async () => {
    const bytes = await downloadBook(
      book,
      site({ "/books/esempio@1.0.0.ptsb": pkg }),
      1024,
    );
    expect(bytes).toEqual(pkg);
  });

  it("refuses a package that differs from the catalog", async () => {
    const other = new TextEncoder().encode("PK fake smartbooK");
    await expect(
      downloadBook(book, site({ "/books/esempio@1.0.0.ptsb": other }), 1024),
    ).rejects.toThrow("books-integrity");
    const longer = new TextEncoder().encode("PK fake smartbook, longer");
    await expect(
      downloadBook(book, site({ "/books/esempio@1.0.0.ptsb": longer }), 1024),
    ).rejects.toThrow("books-integrity");
  });

  it("refuses a book over the import limit before downloading it", async () => {
    await expect(
      downloadBook(book, site({}), pkg.byteLength - 1),
    ).rejects.toThrow("source-too-big");
  });
});

describe("download timeout", () => {
  /** Sends the package in four parts, `gap` ms apart, and stops when the signal aborts. */
  const slow =
    (gap: number): BooksTransport =>
    (_url, _max, signal, progress) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        let sent = 0;
        const next = () => {
          if (signal.aborted) return;
          sent += 1;
          progress?.();
          if (sent === 4) resolve(pkg);
          else setTimeout(next, gap);
        };
        setTimeout(next, gap);
      });

  it("lets a slow download finish while bytes keep arriving", async () => {
    // Four parts 40 ms apart take 160 ms in all, past the 100 ms limit, but no single wait reaches it.
    await expect(downloadBook(book, slow(40), 1024, undefined, 100)).resolves.toEqual(pkg);
  });

  it("calls a download that stops sending offline", async () => {
    await expect(downloadBook(book, slow(150), 1024, undefined, 100)).rejects.toThrow("books-offline");
  });
});
