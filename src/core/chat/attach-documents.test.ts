import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { hasBlob, readBlob } from "../blobs";
import { sha256 } from "../sources/quality";
import { IpcError } from "../../shared/ipc";
import { extractPlain, manyPagePdf, storeExtracted } from "../sources/documents";
import { setSourceWorkerDirectory } from "../sources/worker-client";
import { extractInWorker, prepareFiles } from "./attach";

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-attach-docs-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const noImages = async (): Promise<never> => {
  throw new Error("no images in these tests");
};
const attach = (
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  path: string,
  extract: Parameters<typeof prepareFiles>[8],
  signal?: AbortSignal,
) =>
  prepareFiles(
    db,
    workspace,
    [path],
    "claude-sonnet-5",
    noImages,
    signal,
    noImages,
    noImages,
    extract,
  );

describe("ASK-04 a chat document is read off the core thread, then stored", () => {
  it("hands the worker the bytes core read within its cap, and parses nothing itself", async () => {
    const workspace = scratch();
    const db = openDatabase(":memory:");
    // Not a PDF at all. Core extraction would throw on it; only a worker (here a stub) is asked to read it.
    const path = join(workspace, "dispensa.pdf");
    writeFileSync(path, "%PDF-not really, only bytes");
    const seen: Array<{ path: string; ext: string; text: string }> = [];
    const prepared = await attach(
      db,
      workspace,
      path,
      async (file, ext, bytes) => {
        seen.push({ path: file, ext, text: Buffer.from(bytes).toString() });
        return extractPlain("Il calore si trasmette per conduzione.", false);
      },
    );
    expect(seen).toEqual([
      { path, ext: ".pdf", text: "%PDF-not really, only bytes" },
    ]);
    const [source] = db
      .prepare(
        `SELECT id, kind, mime, library, blob_sha AS sha, status FROM sources`,
      )
      .all() as Array<{
      id: string;
      kind: string;
      mime: string;
      library: number;
      sha: string;
      status: string;
    }>;
    expect(prepared.sourceIds).toEqual([source!.id]);
    expect(source).toMatchObject({
      kind: "pdf",
      mime: "application/pdf",
      library: 0,
      status: "ready",
    });
    // The stored original is the same bytes the worker read.
    expect(readBlob(workspace, source!.sha).file).toBeTruthy();
    expect(
      db
        .prepare(`SELECT text FROM passages WHERE source_id = ?`)
        .all(source!.id),
    ).toEqual([{ text: "Il calore si trasmette per conduzione." }]);
    db.close();
  });

  it("never shows the attachment to the library, not even if something fails right after it is stored", async () => {
    const workspace = scratch();
    const db = openDatabase(":memory:");
    // If hiding the row fails, the insert must go with it, instead of leaving a library-visible source behind.
    db.exec(
      `CREATE TRIGGER fail_hide BEFORE UPDATE OF library ON sources BEGIN SELECT RAISE(ABORT, 'hide failed'); END`,
    );
    const path = join(workspace, "note.txt");
    writeFileSync(path, "Energia e lavoro");
    await expect(
      attach(db, workspace, path, async () =>
        extractPlain("Energia e lavoro", false),
      ),
    ).rejects.toThrow("hide failed");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({
      n: 0,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM passages`).get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("stores nothing when the turn is cancelled during the read", async () => {
    const workspace = scratch();
    const db = openDatabase(":memory:");
    const path = join(workspace, "note.txt");
    writeFileSync(path, "Energia e lavoro");
    const controller = new AbortController();
    await expect(
      attach(
        db,
        workspace,
        path,
        async () => {
          controller.abort();
          return extractPlain("Energia e lavoro", false);
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({
      n: 0,
    });
    db.close();
  });

  describe("a set of files is stored all together or not at all", () => {
    // A text-only model, so the picture is read by local OCR after the document before it.
    const many = (
      db: ReturnType<typeof openDatabase>,
      workspace: string,
      paths: string[],
      recognize: Parameters<typeof prepareFiles>[4],
      signal?: AbortSignal,
    ) =>
      prepareFiles(db, workspace, paths, "text-only-small", recognize, signal, noImages, noImages, async (_path, _ext, bytes) =>
        extractPlain(Buffer.from(bytes).toString(), false),
      );
    const counts = (db: ReturnType<typeof openDatabase>) =>
      ["sources", "passages", "source_documents"].map(
        (table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
    const files = (workspace: string) => {
      const text = join(workspace, "a.txt");
      writeFileSync(text, "Energia e lavoro, privato");
      const photo = join(workspace, "b.png");
      writeFileSync(photo, Buffer.from("not a real picture, only bytes"));
      return { text, photo, textSha: sha256(readFileSync(text)), photoSha: sha256(readFileSync(photo)) };
    };

    it("leaves no source, passage or blob when a later photo has no OCR data", async () => {
      const workspace = scratch();
      const db = openDatabase(":memory:");
      const { text, photo, textSha, photoSha } = files(workspace);
      await expect(
        many(db, workspace, [text, photo], async () => {
          throw new Error("ocr-data-missing");
        }),
      ).rejects.toMatchObject({ messageKey: "sources.ocrDataMissing" });
      expect(counts(db)).toEqual([0, 0, 0]);
      expect(hasBlob(workspace, textSha)).toBe(false);
      expect(hasBlob(workspace, photoSha)).toBe(false);
      db.close();
    });

    it("leaves nothing when the turn is cancelled while a later photo is read", async () => {
      const workspace = scratch();
      const db = openDatabase(":memory:");
      const { text, photo, textSha, photoSha } = files(workspace);
      const controller = new AbortController();
      await expect(
        many(
          db,
          workspace,
          [text, photo],
          async () => {
            controller.abort();
            return "text";
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(counts(db)).toEqual([0, 0, 0]);
      expect(hasBlob(workspace, textSha)).toBe(false);
      expect(hasBlob(workspace, photoSha)).toBe(false);
      db.close();
    });

    it("stores every document and photo once the whole set has been read", async () => {
      const workspace = scratch();
      const db = openDatabase(":memory:");
      const { text, photo, textSha, photoSha } = files(workspace);
      const prepared = await many(db, workspace, [text, photo], async () => "riga");
      expect(prepared.sourceIds).toHaveLength(1);
      expect(prepared.notes).toEqual(["riga"]);
      expect(db.prepare(`SELECT library FROM sources`).all()).toEqual([{ library: 0 }]);
      expect(hasBlob(workspace, textSha)).toBe(true);
      expect(hasBlob(workspace, photoSha)).toBe(true);
      db.close();
    });

    it("when the commit fails, removes only the blobs it made new, never one a stored source already uses", async () => {
      const workspace = scratch();
      const db = openDatabase(":memory:");
      const first = join(workspace, "a.txt");
      writeFileSync(first, "Gia in biblioteca");
      const second = join(workspace, "b.txt");
      writeFileSync(second, "Solo in questa chat");
      // The first file's bytes are already a library source's original.
      const library = storeExtracted(db, workspace, {
        title: "Libreria",
        kind: "txt",
        mime: "text/plain",
        ext: ".txt",
        bytes: readFileSync(first),
        extracted: extractPlain("Gia in biblioteca", false),
      });
      db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON sources WHEN NEW.title = 'b' BEGIN SELECT RAISE(ABORT, 'second failed'); END`);
      await expect(many(db, workspace, [first, second], async () => "")).rejects.toThrow("second failed");
      expect(db.prepare(`SELECT id FROM sources`).all()).toEqual([{ id: library.sourceId }]);
      expect(hasBlob(workspace, sha256(readFileSync(first)))).toBe(true);
      expect(hasBlob(workspace, sha256(readFileSync(second)))).toBe(false);
      db.close();
    });
  });

  it("refuses a file over the attachment cap before any worker starts", async () => {
    const workspace = scratch();
    const db = openDatabase(":memory:");
    const path = join(workspace, "big.txt");
    writeFileSync(path, Buffer.alloc(15 * 1024 * 1024 + 1));
    let asked = false;
    await expect(
      attach(
        db,
        workspace,
        path,
        async () => ((asked = true), extractPlain("x", false)),
      ),
    ).rejects.toThrow("attach-too-big");
    expect(asked).toBe(false);
    db.close();
  });
});

// These start the built extract worker, so they need a build of this tree (`npx electron-vite build`, or
// PYXIS_WORKER_DIR pointing at one). A build from before the bounded zip reader, or none, skips them by name.
const built = resolve(process.env.PYXIS_WORKER_DIR ?? "out/main");
const chunks = join(built, "chunks");
const have =
  existsSync(join(built, "extract-worker.js")) &&
  existsSync(chunks) &&
  readdirSync(chunks).some((name) =>
    readFileSync(join(chunks, name), "utf8").includes("archive-corrupt"),
  );
const MIB = 1024 * 1024;

/** Rewrites the declared sizes in every header, so the archive claims to be tiny. */
function lie(zip: Uint8Array): Uint8Array {
  const out = Buffer.from(zip);
  for (let i = 0; i + 30 <= out.length; i += 1) {
    if (out.readUInt32LE(i) === 0x04034b50) out.writeUInt32LE(10, i + 22);
    if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt32LE(10, i + 24);
  }
  return out;
}

describe.skipIf(!have)(
  "a chat document through the built extract worker",
  () => {
    beforeAll(() => setSourceWorkerDirectory(built));
    afterAll(() => setSourceWorkerDirectory(resolve("out/main")));

    it("reads a real PDF and a .pptx, and keeps core responsive while it does", async () => {
      const workspace = scratch();
      const db = openDatabase(":memory:");
      const pdf = join(workspace, "libro.pdf");
      writeFileSync(pdf, manyPagePdf(400, "energia interna del sistema"));
      const pptx = join(workspace, "slide.pptx");
      writeFileSync(
        pptx,
        zipSync({
          "ppt/presentation.xml": strToU8(
            '<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
          ),
          "ppt/_rels/presentation.xml.rels": strToU8(
            '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
          ),
          "ppt/slides/slide1.xml": strToU8("<p:sld><a:t>forza</a:t></p:sld>"),
        }),
      );
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 5);
      const prepared = await prepareFiles(
        db,
        workspace,
        [pdf, pptx],
        "claude-sonnet-5",
        noImages,
        undefined,
        noImages,
        noImages,
      );
      clearInterval(timer);
      expect(prepared.sourceIds).toHaveLength(2);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM passages`).get(),
      ).toMatchObject({ n: 401 });
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE library = 0`).get(),
      ).toEqual({ n: 2 });
      // The 400-page parse ran in the worker, so the core event loop kept ticking through it.
      expect(ticks).toBeGreaterThan(20);
      db.close();
    }, 60_000);

    it("refuses a .docx whose header lies about its size, as too big, without storing it", async () => {
      const workspace = scratch();
      const db = openDatabase(":memory:");
      const path = join(workspace, "bomba.docx");
      writeFileSync(
        path,
        lie(
          zipSync({
            "[Content_Types].xml": strToU8("<Types/>"),
            "_rels/.rels": strToU8("<Relationships/>"),
            "word/document.xml": new Uint8Array(65 * MIB),
          }),
        ),
      );
      const error = await attach(db, workspace, path, undefined).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(IpcError);
      expect(error).toMatchObject({
        code: "attach-too-big",
        messageKey: "errors.attachTooBig",
        detail: "archive-too-large",
      });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({
        n: 0,
      });
      db.close();
    }, 60_000);

    it("stops a read that outlasts the time limit and says the file is too much, and stops one on cancel", async () => {
      const workspace = scratch();
      const path = join(workspace, "enorme.pdf");
      const bytes = manyPagePdf(
        3000,
        "energia interna del sistema termodinamico",
      );
      writeFileSync(path, bytes);
      await expect(
        extractInWorker(path, ".pdf", bytes, undefined, 30),
      ).rejects.toMatchObject({
        code: "attach-too-big",
        detail: "attach-extract-timeout",
      });
      const controller = new AbortController();
      const pending = extractInWorker(path, ".pdf", bytes, controller.signal);
      setTimeout(() => controller.abort(), 30);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    }, 60_000);
  },
);
