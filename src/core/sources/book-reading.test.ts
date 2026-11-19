import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { addSubject } from "../plans/subjects";
import { folderTransport, type BooksTransport } from "./books";
import { createBookReading } from "./book-reading";
import { sourceHandlers } from "./handlers";
import { markStoppedImport, registerSourceJobs } from "./jobs";
import { parseSmartbook } from "./smartbook";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const SPEED = "La velocità media è lo spazio percorso diviso il tempo.";
const MARKUP = '<script>alert("x")</script> e <b>grassetto</b>';

function pack(): Uint8Array {
  return zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "fisica-demo",
        title: "Fisica di prova",
        version: "1.0.0",
        access: "public",
        chapters: [
          { id: "moti", number: 1, title: "Moti", file: "01.md" },
          { id: "forze", number: 2, title: "Forze", file: "02.md" },
        ],
      }),
    ),
    "chapters/01.md": strToU8(`## p1 | Velocità\n${SPEED}\n\n## p2 | Altro\n${MARKUP}\n`),
    "chapters/02.md": strToU8("## p1 | Dinamica\nLa forza è massa per accelerazione.\n"),
  });
}

/** A folder laid out like books.politost.it, and a transport that counts the package downloads. */
function site(options: { tamper?: boolean } = {}) {
  const dir = temp("pyxis-book-reading-site-");
  const bytes = pack();
  mkdirSync(join(dir, "books"));
  writeFileSync(join(dir, "books", "fisica-demo@1.0.0.ptsb"), bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(
    join(dir, "catalog.json"),
    JSON.stringify({
      catalogVersion: 1,
      books: [
        {
          id: "fisica-demo",
          title: "Fisica di prova",
          subject: "Fisica",
          authors: ["PoliTost"],
          version: "1.0.0",
          chapters: 2,
          package: "books/fisica-demo@1.0.0.ptsb",
          bytes: bytes.byteLength,
          sha256: options.tamper ? sha.replace(/^./, sha[0] === "0" ? "1" : "0") : sha,
        },
      ],
    }),
  );
  const inner = folderTransport(dir);
  const downloads = { packages: 0, catalogs: 0 };
  const transport: BooksTransport = (url, max, signal, progress) => {
    if (url.endsWith(".ptsb")) downloads.packages += 1;
    else downloads.catalogs += 1;
    return inner(url, max, signal, progress);
  };
  return { transport, downloads, dir };
}

function setup(options: { tamper?: boolean } = {}) {
  const workspace = temp("pyxis-book-reading-");
  const db = openDatabase(":memory:");
  const runner = createRunner(db, (job) => markStoppedImport(db, job));
  const books = site(options);
  const handlers = sourceHandlers(db, workspace, runner, undefined, undefined, books.transport);
  registerSourceJobs(db, workspace, runner, (async (input: { path: string }) => ({
    book: parseSmartbook(new Uint8Array(readFileSync(input.path))),
  })) as never);
  return { workspace, db, runner, handlers, downloads: books.downloads, siteDir: books.dir, transport: books.transport };
}

const count = (db: ReturnType<typeof openDatabase>, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("reading a free book before it is added", () => {
  it("shows its chapters and text and stores nothing, in the database or the workspace", async () => {
    const ctx = setup();
    const before = readdirSync(ctx.workspace);
    const preview = await ctx.handlers.bookPreview({ id: "fisica-demo" });
    expect(preview.chapters).toEqual([
      { number: 1, title: "Moti" },
      { number: 2, title: "Forze" },
    ]);
    const first = await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 1 });
    expect(first.map((row) => row.text)).toEqual([SPEED, MARKUP]);
    expect(new Set(first.map((row) => row.id)).size).toBe(2);
    expect((await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 2 }))[0]?.text).toContain("massa per accelerazione");
    expect(await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 9 })).toEqual([]);
    for (const table of ["sources", "passages", "source_documents", "smartbooks", "exercises"]) expect(count(ctx.db, table)).toBe(0);
    expect(readdirSync(ctx.workspace)).toEqual(before);
    // The books list still says the student does not have it.
    expect(await ctx.handlers.books()).toEqual([expect.objectContaining({ id: "fisica-demo", sourceId: null })]);
    expect(ctx.downloads.packages).toBe(1);
    ctx.db.close();
  });

  it("is not downloaded again when the student adds it after reading, and the add puts it on the chosen shelf", async () => {
    const ctx = setup();
    const subject = addSubject(ctx.db, "Fisica 1");
    await ctx.handlers.bookPreview({ id: "fisica-demo" });
    const added = await ctx.handlers.importBook({ id: "fisica-demo", subjectId: subject.id });
    expect(ctx.downloads.packages).toBe(1);
    expect(ctx.db.prepare("SELECT subject_id AS subject, subject_sort AS sort, library FROM sources WHERE id = ?").get(added.sourceId)).toEqual({
      subject: subject.id,
      sort: "manual",
      library: 1,
    });
    await expect.poll(() => (ctx.db.prepare("SELECT state FROM jobs WHERE id = ?").get(added.jobId!) as { state: string }).state, { timeout: 15_000 }).toBe("succeeded");
    ctx.db.close();
  });

  it("goes on reading an open book after it is added, from what is held or stored, with no second download and no network", async () => {
    const ctx = setup();
    await ctx.handlers.bookPreview({ id: "fisica-demo" });
    expect((await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 1 }))[0]?.text).toBe(SPEED);
    const added = await ctx.handlers.importBook({ id: "fisica-demo" });
    await expect.poll(() => (ctx.db.prepare("SELECT state FROM jobs WHERE id = ?").get(added.jobId!) as { state: string }).state, { timeout: 15_000 }).toBe("succeeded");
    // The package leaves the site: a chapter not read yet must not need it.
    rmSync(join(ctx.siteDir, "books"), { recursive: true, force: true });
    expect((await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 2 }))[0]?.text).toContain("massa per accelerazione");
    expect(ctx.downloads.packages).toBe(1);
    // After the held copy is gone (another launch, or ten minutes), the stored book answers the same way.
    const later = sourceHandlers(ctx.db, ctx.workspace, ctx.runner, undefined, undefined, ctx.transport);
    expect((await later.bookChapter({ id: "fisica-demo", chapter: 2 }))[0]?.text).toContain("massa per accelerazione");
    expect((await later.bookPreview({ id: "fisica-demo" })).chapters).toHaveLength(2);
    expect(ctx.downloads.packages).toBe(1);
    ctx.db.close();
  });

  it("reads a book that was added with no network at all, after the catalog it was read from has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = setup();
    const added = await ctx.handlers.importBook({ id: "fisica-demo" });
    await expect.poll(() => (ctx.db.prepare("SELECT state FROM jobs WHERE id = ?").get(added.jobId!) as { state: string }).state, { timeout: 15_000 }).toBe("succeeded");
    // The site is gone, and the five minutes the catalog is kept have passed: the book is read from what is stored.
    rmSync(ctx.siteDir, { recursive: true, force: true });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const later = sourceHandlers(ctx.db, ctx.workspace, ctx.runner, undefined, undefined, ctx.transport);
    for (const handlers of [ctx.handlers, later]) {
      expect((await handlers.bookPreview({ id: "fisica-demo" })).chapters).toEqual([
        { number: 1, title: "Moti" },
        { number: 2, title: "Forze" },
      ]);
      expect((await handlers.bookChapter({ id: "fisica-demo", chapter: 1 }))[0]?.text).toBe(SPEED);
    }
    // A book that is not stored still needs the catalog, which has the address and the checksum of its package.
    await expect(ctx.handlers.bookPreview({ id: "altro" })).rejects.toMatchObject({ messageKey: "sources.books.offline" });
    ctx.db.close();
  });

  it("goes on reading a book that was opened before it is added from the held package, whatever the catalog says by then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = setup();
    const preview = await ctx.handlers.bookPreview({ id: "fisica-demo" });
    expect(preview.chapters).toHaveLength(2);
    // The catalog now lists a newer version of the book with one chapter fewer, and its five minutes have passed.
    const catalog = JSON.parse(readFileSync(join(ctx.siteDir, "catalog.json"), "utf8"));
    catalog.books[0].version = "1.1.0";
    catalog.books[0].sha256 = "a".repeat(64);
    writeFileSync(join(ctx.siteDir, "catalog.json"), JSON.stringify(catalog));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    // The chapter comes from the package the chapters were listed from, so the two agree, and nothing is downloaded.
    expect((await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 2 }))[0]?.text).toContain("massa per accelerazione");
    expect(ctx.downloads.packages).toBe(1);
    // With the site gone as well, the book still reads while it is held.
    rmSync(ctx.siteDir, { recursive: true, force: true });
    expect((await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 1 }))[0]?.text).toBe(SPEED);
    ctx.db.close();
  });

  it("lists the chapters of the package it reads from, so a held version 1 is not listed from a hidden copy of version 2", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = setup();
    // Version 1 is opened and held.
    expect((await ctx.handlers.bookPreview({ id: "fisica-demo" })).chapters.map((chapter) => chapter.title)).toEqual(["Moti", "Forze"]);
    // The catalog now lists version 2, with other chapters, and it is in the workspace as a copy no Library shelf shows, the
    // way an exam that was made from it keeps it.
    const next = zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "fisica-demo",
          title: "Fisica di prova",
          version: "2.0.0",
          access: "public",
          chapters: [{ id: "cinematica", number: 1, title: "Cinematica", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8("## p1 | Moto\nVERSIONE DUE del testo.\n"),
    });
    writeFileSync(join(ctx.siteDir, "books", "fisica-demo@2.0.0.ptsb"), next);
    const catalog = JSON.parse(readFileSync(join(ctx.siteDir, "catalog.json"), "utf8"));
    Object.assign(catalog.books[0], {
      version: "2.0.0",
      chapters: 1,
      package: "books/fisica-demo@2.0.0.ptsb",
      bytes: next.byteLength,
      sha256: createHash("sha256").update(next).digest("hex"),
    });
    writeFileSync(join(ctx.siteDir, "catalog.json"), JSON.stringify(catalog));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const added = await ctx.handlers.importBook({ id: "fisica-demo" });
    await expect.poll(() => (ctx.db.prepare("SELECT state FROM jobs WHERE id = ?").get(added.jobId!) as { state: string }).state, { timeout: 15_000 }).toBe("succeeded");
    ctx.db.prepare("UPDATE sources SET library = 0 WHERE id = ?").run(added.sourceId);
    // The reader opens again on the book it has held: the chapters it lists and the text it reads are the same package's.
    const preview = await ctx.handlers.bookPreview({ id: "fisica-demo" });
    const text = await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 1 });
    expect({ chapters: preview.chapters.map((chapter) => chapter.title), first: text[0]?.text }).toEqual({
      chapters: ["Moti", "Forze"],
      first: SPEED,
    });
    ctx.db.close();
  });

  it("reads a chapter from the package the preview listed, or says the book changed, and never reads the catalog's other version as if it were that one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ctx = setup();
    const preview = await ctx.handlers.bookPreview({ id: "fisica-demo" });
    expect(preview.package).toBe(JSON.parse(readFileSync(join(ctx.siteDir, "catalog.json"), "utf8")).books[0].sha256);
    // The catalog now lists version 2, which has one chapter, and the five minutes it is kept have passed.
    const next = zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({ id: "fisica-demo", title: "Fisica di prova", version: "2.0.0", access: "public", chapters: [{ id: "cinematica", number: 1, title: "Cinematica", file: "01.md" }] }),
      ),
      "chapters/01.md": strToU8("## p1 | Moto\nVERSIONE DUE del testo.\n"),
    });
    writeFileSync(join(ctx.siteDir, "books", "fisica-demo@2.0.0.ptsb"), next);
    const catalog = JSON.parse(readFileSync(join(ctx.siteDir, "catalog.json"), "utf8"));
    Object.assign(catalog.books[0], { version: "2.0.0", chapters: 1, package: "books/fisica-demo@2.0.0.ptsb", bytes: next.byteLength, sha256: createHash("sha256").update(next).digest("hex") });
    writeFileSync(join(ctx.siteDir, "catalog.json"), JSON.stringify(catalog));
    vi.setSystemTime(Date.now() + 6 * 60_000);
    // The held package is gone, by its time or because the book was read from another window.
    const later = sourceHandlers(ctx.db, ctx.workspace, ctx.runner, undefined, undefined, ctx.transport);
    // Chapter 2 exists only in the version the reader was shown: asked without the package it gets the catalog's version, which
    // has none, and asked with it, it gets an answer that says so and not the other version's text or nothing.
    expect(await later.bookChapter({ id: "fisica-demo", chapter: 2 })).toEqual([]);
    await expect(later.bookChapter({ id: "fisica-demo", chapter: 2, package: preview.package })).rejects.toMatchObject({ messageKey: "sources.books.changed" });
    // A reader opened again lists the version the catalog has, and reads it.
    const again = await later.bookPreview({ id: "fisica-demo" });
    expect(again.chapters.map((chapter) => chapter.title)).toEqual(["Cinematica"]);
    expect(again.package).not.toBe(preview.package);
    expect((await later.bookChapter({ id: "fisica-demo", chapter: 1, package: again.package }))[0]?.text).toContain("VERSIONE DUE");
    // The package it was listed from still answers while it is held.
    expect((await ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 2, package: preview.package }))[0]?.text).toContain("massa per accelerazione");
    ctx.db.close();
  });

  it("adds a book that was never read with one download, and refuses an unknown shelf before downloading anything", async () => {
    const ctx = setup();
    await expect(ctx.handlers.importBook({ id: "fisica-demo", subjectId: "gone" })).rejects.toMatchObject({ messageKey: "sources.sort.subjectMissing" });
    expect(ctx.downloads.packages).toBe(0);
    expect(count(ctx.db, "sources")).toBe(0);
    await ctx.handlers.importBook({ id: "fisica-demo" });
    expect(ctx.downloads.packages).toBe(1);
    ctx.db.close();
  });

  it("refuses the add, and imports nothing, when the shelf is deleted while the book downloads", async () => {
    const ctx = setup();
    const subject = addSubject(ctx.db, "Fisica 1");
    // The shelf goes while the package is on its way.
    const deleting: BooksTransport = (url, max, signal, progress) => {
      if (url.endsWith(".ptsb")) ctx.db.prepare("DELETE FROM subjects WHERE id = ?").run(subject.id);
      return ctx.transport(url, max, signal, progress);
    };
    const handlers = sourceHandlers(ctx.db, ctx.workspace, ctx.runner, undefined, undefined, deleting);
    await expect(handlers.importBook({ id: "fisica-demo", subjectId: subject.id })).rejects.toMatchObject({
      messageKey: "sources.sort.subjectMissing",
    });
    expect(count(ctx.db, "sources")).toBe(0);
    expect(count(ctx.db, "jobs")).toBe(0);
    ctx.db.close();
  });

  it("refuses a package that does not match the catalog, and an id the catalog does not list", async () => {
    const ctx = setup({ tamper: true });
    await expect(ctx.handlers.bookPreview({ id: "fisica-demo" })).rejects.toMatchObject({ messageKey: "sources.books.integrity" });
    await expect(ctx.handlers.bookChapter({ id: "fisica-demo", chapter: 1 })).rejects.toMatchObject({ messageKey: "sources.books.integrity" });
    await expect(ctx.handlers.bookPreview({ id: "nessuno" })).rejects.toMatchObject({ messageKey: "sources.books.missing" });
    expect(count(ctx.db, "sources")).toBe(0);
    ctx.db.close();
  });
});

describe("the book held in memory", () => {
  const book = (() => {
    const bytes = pack();
    return {
      book: {
        id: "fisica-demo",
        title: "Fisica di prova",
        subject: "Fisica",
        authors: [],
        version: "1.0.0",
        chapters: 2,
        package: "books/fisica-demo@1.0.0.ptsb",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      bytes,
    };
  })();

  it("shares one download between calls made at the same time, and lets go after its time", async () => {
    let downloads = 0;
    const transport: BooksTransport = async () => {
      downloads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return book.bytes;
    };
    const reading = createBookReading(60);
    await Promise.all([1, 2, 3].map(() => reading.open(book.book, transport, 10_000_000)));
    expect(downloads).toBe(1);
    expect(reading.bytesOf(book.book)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(reading.bytesOf(book.book)).toBeNull();
    await reading.open(book.book, transport, 10_000_000);
    expect(downloads).toBe(2);
    reading.drop();
  });

  it("lets a caller stop waiting without cancelling the download for the others", async () => {
    const transport: BooksTransport = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return book.bytes;
    };
    const reading = createBookReading();
    const stop = new AbortController();
    const waiting = reading.open(book.book, transport, 10_000_000, stop.signal);
    const other = reading.open(book.book, transport, 10_000_000);
    stop.abort();
    await expect(waiting).rejects.toBeDefined();
    await expect(other).resolves.toBeDefined();
    reading.drop();
  });
});
