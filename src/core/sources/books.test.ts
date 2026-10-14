import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compareBookVersions,
  downloadBook,
  isNewerBook,
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

describe("book versions", () => {
  it("orders semver versions the way the books repository does", () => {
    expect(compareBookVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareBookVersions("1.10.0", "1.9.3")).toBe(1);
    expect(compareBookVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareBookVersions("1.0.0", "1.0.0+build.7")).toBe(0);
    // A prerelease comes before its release, and numeric identifiers compare as numbers.
    expect(compareBookVersions("1.1.0-beta.2", "1.1.0")).toBe(-1);
    expect(compareBookVersions("1.1.0-beta.10", "1.1.0-beta.2")).toBe(1);
    expect(compareBookVersions("1.1.0-beta", "1.1.0-1")).toBe(1);
    expect(compareBookVersions("1.1.0-beta", "1.1.0-beta.1")).toBe(-1);
    expect(compareBookVersions("1.1", "1.0.0")).toBeNull();
    expect(compareBookVersions("1.0.0", "edizione 2")).toBeNull();
  });

  it("offers only a different package with a higher version", () => {
    const at = (version: string, sha = "b".repeat(64)) => ({ version, sha256: sha });
    const mine = { version: "1.0.0", sha: "a".repeat(64) };
    expect(isNewerBook(at("1.1.0"), mine)).toBe(true);
    expect(isNewerBook(at("1.0.0"), mine)).toBe(false);
    // A catalog that went back to an older version offers nothing.
    expect(isNewerBook(at("0.9.0"), mine)).toBe(false);
    // The same bytes are the same book, whatever the version says.
    expect(isNewerBook(at("2.0.0", "a".repeat(64)), mine)).toBe(false);
    // Without semver on both sides, a different version string with a different package counts as newer.
    expect(isNewerBook(at("edizione 2"), { ...mine, version: "edizione 1" })).toBe(true);
    expect(isNewerBook(at("edizione 1"), { ...mine, version: "edizione 1" })).toBe(false);
    // A copy with no known version is never offered an update.
    expect(isNewerBook(at("1.1.0"), { ...mine, version: null })).toBe(false);
  });
});
