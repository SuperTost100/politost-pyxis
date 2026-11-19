import { closeSync, ftruncateSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import type { AttachmentView } from "../../shared/ipc";
import { extractPlain } from "../sources/documents";
import { registerOcrJob, startScan } from "../sources/ocr-job";
import { sha256 } from "../sources/quality";
import { tempDir } from "../test-temp";
import { heldFilesFor } from "./test-attach";

const opened: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

function setup(options: Parameters<typeof heldFilesFor>[2] = {}) {
  const workspace = tempDir("pyxis-held-");
  const db = openDatabase(join(workspace, "pyxis.db"));
  opened.push(db);
  const events: AttachmentView[] = [];
  const files = heldFilesFor(db, workspace, { emit: (view) => events.push(view), ...options });
  const write = (name: string, text: string) => {
    const path = join(workspace, name);
    writeFileSync(path, text);
    return path;
  };
  const sources = () => db.prepare(`SELECT id, library, status FROM sources`).all() as Array<{ id: string; library: number; status: string }>;
  const last = (id: string) => events.filter((event) => event.id === id).at(-1);
  return { workspace, db, files, events, write, sources, last };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout");
}

/** A scanned PDF of `count` pages as the extract worker reports it: pages with no text. */
const scanned = (count = 1) => async () => ({
  document: { pages: Array.from({ length: count }, (_, at) => ({ text: "", locator: { page: at + 1 }, section: "" })), scanned: true },
});

describe("a document is read when it is attached", () => {
  it("reads it with the Library's import into a hidden source, and tells the window how it goes", async () => {
    const { files, write, sources, last, events, db, workspace } = setup();
    const view = await files.held.attach(write("dispensa.txt", "Il calore si trasmette per conduzione."));
    expect(view).toMatchObject({ name: "dispensa.txt", kind: "document", state: "reading", phase: "read" });
    await until(() => last(view.id)?.state === "ready");
    // Hidden from the Library, as every chat attachment, and its passages are stored before the message is.
    expect(sources()).toEqual([expect.objectContaining({ library: 0, status: "ready" })]);
    expect(db.prepare(`SELECT COUNT(*) FROM passages`).pluck().get()).toBeGreaterThan(0);
    expect(events.map((event) => event.state)).toContain("reading");
    // The jobs list never shows it: the chip is where the student sees the reading.
    expect(files.runner.list()).toEqual([]);
    expect(files.runner.finished()).toEqual([]);
    expect(hasBlob(workspace, sha256(new TextEncoder().encode("Il calore si trasmette per conduzione.")))).toBe(true);
  });

  it("takes no chat limit of its own: a file past the old 15 MB and a ninth file past eight are read like any other", async () => {
    const { files, workspace } = setup({ extract: async () => ({ document: extractPlain("testo", false) }) });
    const big = join(workspace, "grande.pdf");
    writeFileSync(big, "%PDF-1.7 ");
    const fd = openSync(big, "r+");
    ftruncateSync(fd, 20 * 1024 * 1024);
    closeSync(fd);
    const view = await files.held.attach(big);
    expect(view.state).not.toBe("failed");
    await files.held.settle([view.id]);
    expect(files.held.list([view.id])[0]).toMatchObject({ state: "ready" });
  });

  it("refuses only what the Library refuses: 256 MB for a document and 40 MB for a photo", async () => {
    const { files, workspace } = setup();
    const sparse = (name: string, size: number) => {
      const path = join(workspace, name);
      writeFileSync(path, "x");
      const fd = openSync(path, "r+");
      ftruncateSync(fd, size);
      closeSync(fd);
      return path;
    };
    expect(await files.held.attach(sparse("enorme.pdf", 257 * 1024 * 1024))).toMatchObject({ state: "failed", error: "too-large", kind: "document" });
    expect(await files.held.attach(sparse("enorme.jpg", 41 * 1024 * 1024))).toMatchObject({ state: "failed", error: "too-large", kind: "photo" });
  });

  it("names why a file cannot be read: a password, a damaged file, a type a message cannot carry", async () => {
    const { files, write, last } = setup({
      extract: async ({ path }) => {
        throw new Error(readFileSync(path, "utf8").includes("chiuso") ? "pdf-password-required" : "boom");
      },
    });
    const locked = await files.held.attach(write("a.pdf", "%PDF chiuso"));
    const broken = await files.held.attach(write("b.pdf", "%PDF rotto"));
    await until(() => last(locked.id)?.state === "failed" && last(broken.id)?.state === "failed");
    expect(last(locked.id)).toMatchObject({ state: "failed", error: "password" });
    expect(last(broken.id)).toMatchObject({ state: "failed", error: "unreadable" });
    expect(await files.held.attach(write("libro.ptsb", "x"))).toMatchObject({ state: "failed", error: "unsupported" });
  });

  it("says a reading that was stopped from outside was stopped", async () => {
    const {
      files: { runner, held },
      write,
      last,
    } = setup({
      extract: (_input, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    });
    const files = { held };
    const view = await files.held.attach(write("lento.txt", "abc"));
    expect(last(view.id)?.state).toBe("reading");
    runner.stopAll();
    await until(() => last(view.id)?.state === "failed");
    expect(last(view.id)).toMatchObject({ error: "cancelled" });
  });
});

describe("a scanned PDF is read page by page when it is attached", () => {
  /** The Library's scan job with a page reader that waits on `gate`, so a test can look at the reading half way. */
  function scanSetup(pages: number) {
    const gate: { open: () => void; waiting: Promise<void> } = { open: () => {}, waiting: Promise.resolve() };
    const t = setup({
      extract: scanned(pages),
      scan: async (id) => {
        startScan(t.db, t.files.runner, id);
        return "started";
      },
    });
    registerOcrJob(t.db, t.workspace, t.files.runner, {
      readPages: async (_path, wanted, signal) => {
        if (wanted.includes(9)) {
          gate.waiting = new Promise<void>((resolve) => (gate.open = resolve));
          await gate.waiting;
        }
        signal.throwIfAborted();
        return { count: pages, pages: wanted.filter((page) => page <= pages).map((page) => ({ page, text: `Pagina ${page} di fisica` })) };
      },
      requireData: async () => {},
      onReady: () => {},
    });
    // The import stores the page count of the file, which the scan job's progress is measured against.
    return { ...t, gate };
  }

  it("starts the scan by itself and shows page N of M, then is ready with the text of every page", async () => {
    const t = scanSetup(12);
    const view = await t.files.held.attach(t.write("scansione.pdf", "%PDF"));
    await until(() => t.last(view.id)?.phase === "scan");
    // The first batch of eight pages is read and the second waits: the ninth is the page being read.
    await until(() => t.last(view.id)?.page === 9 && t.last(view.id)?.pages === 12).catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(t.events.filter((event) => event.id === view.id))}`);
    });
    expect(t.last(view.id)).toMatchObject({ state: "reading", phase: "scan", page: 9, pages: 12 });
    t.gate.open();
    await until(() => t.last(view.id)?.state === "ready");
    const text = t.db.prepare(`SELECT COUNT(DISTINCT json_extract(locator_json, '$.page')) FROM passages`).pluck().get();
    expect(text).toBe(12);
    expect(t.files.runner.list()).toEqual([]);
  });

  it("waits for the OCR data when it is not on this computer, and reads the scan once it is", async () => {
    let ready = false;
    const t = setup({ extract: scanned(), scan: async () => (ready ? "started" : "needs-data") });
    registerOcrJob(t.db, t.workspace, t.files.runner, {
      readPages: async (_path, wanted) => ({ count: 1, pages: wanted.filter((page) => page === 1).map((page) => ({ page, text: "Pagina 1" })) }),
      requireData: async () => {},
      onReady: () => {},
    });
    const view = await t.files.held.attach(t.write("scansione.pdf", "%PDF"));
    await until(() => t.last(view.id)?.state === "needs-data");
    expect(t.last(view.id)).toMatchObject({ phase: "scan" });
    expect((await t.files.held.settle([view.id]), t.files.held.take([view.id]).leftOut)).toEqual([{ id: view.id, name: "scansione.pdf", error: "data" }]);
  });

  it("reads the scan after the data download, without attaching the file again", async () => {
    let ready = false;
    const t = setup({
      extract: scanned(),
      scan: async (id) => {
        if (!ready) return "needs-data";
        startScan(t.db, t.files.runner, id);
        return "started";
      },
    });
    registerOcrJob(t.db, t.workspace, t.files.runner, {
      readPages: async (_path, wanted) => ({ count: 1, pages: wanted.filter((page) => page === 1).map((page) => ({ page, text: "Pagina 1" })) }),
      requireData: async () => {},
      onReady: () => {},
    });
    const view = await t.files.held.attach(t.write("scansione.pdf", "%PDF"));
    await until(() => t.last(view.id)?.state === "needs-data");
    ready = true;
    await t.files.held.scan(view.id);
    await until(() => t.last(view.id)?.state === "ready");
    expect(t.files.held.take([view.id]).documents).toHaveLength(1);
  });
});

describe("taking a file off", () => {
  it("stops its reading and leaves no source, passage or stored file behind", async () => {
    const { files, write, sources, db, workspace } = setup();
    const text = "Un testo che solo questo file contiene.";
    const view = await files.held.attach(write("tolto.txt", text));
    files.held.detach(view.id);
    // The reading may have been past its first step, or not started: either way nothing is left.
    await until(() => sources().length === 0);
    expect(db.prepare(`SELECT COUNT(*) FROM passages`).pluck().get()).toBe(0);
    expect(hasBlob(workspace, sha256(new TextEncoder().encode(text)))).toBe(false);
    expect(files.held.list([view.id])).toEqual([]);
  });

  it("stops a reading that is in progress", async () => {
    const { files, write, sources, db } = setup({
      extract: (_input, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    });
    const view = await files.held.attach(write("lento.txt", "abc"));
    await until(() => db.prepare(`SELECT state FROM jobs`).pluck().get() === "running");
    files.held.detach(view.id);
    await until(() => sources().length === 0);
    expect(files.held.list([view.id])).toEqual([]);
    await until(() => db.prepare(`SELECT state FROM jobs`).pluck().get() === "cancelled");
  });

  it("takes off a photo's stored copy, unless a message already holds the same file", async () => {
    const { files, write, workspace, db } = setup({
      fit: async () => ({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }),
    });
    const path = write("foto.png", "pixels");
    const sha = sha256(readFileSync(path));
    const view = await files.held.attach(path);
    await files.held.settle([view.id]);
    expect(hasBlob(workspace, sha)).toBe(true);
    files.held.detach(view.id);
    expect(hasBlob(workspace, sha)).toBe(false);
    // A message that carries the same photo keeps its file.
    db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'q', 1)`).run();
    const again = await files.held.attach(path);
    db.prepare(`INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES ('a', 'm', ?, 'image/png', 1)`).run(sha);
    files.held.detach(again.id);
    expect(hasBlob(workspace, sha)).toBe(true);
  });
});

describe("what a message takes", () => {
  it("waits for every file to be read, then takes the read ones and leaves out the one that failed, by name", async () => {
    const { files, write } = setup({
      extract: async ({ path }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (readFileSync(path, "utf8") === "rotto") throw new Error("boom");
        return { document: extractPlain("Testo del file", false) };
      },
    });
    const good = await files.held.attach(write("buono.txt", "buono"));
    const bad = await files.held.attach(write("rotto.txt", "rotto"));
    await files.held.settle([good.id, bad.id]);
    const taken = files.held.take([good.id, bad.id]);
    expect(taken.documents.map((doc) => doc.name)).toEqual(["buono.txt"]);
    expect(taken.leftOut).toEqual([{ id: bad.id, name: "rotto.txt", error: "unreadable" }]);
    // The one left out stays held, failed, until the send goes through, so a send that fails keeps the composer as it was.
    expect(files.held.list([bad.id])).toEqual([expect.objectContaining({ state: "failed", error: "unreadable" })]);
    files.held.detach(bad.id);
    expect(files.held.list([bad.id])).toEqual([]);
  });

  it("stops waiting when the turn is stopped", async () => {
    const { files, write } = setup({ extract: () => new Promise(() => undefined) });
    const view = await files.held.attach(write("lento.txt", "a"));
    const controller = new AbortController();
    const waiting = files.held.settle([view.id], controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });

  it("carries at most eight files, and names the ones past them", async () => {
    const { files, write } = setup({ extract: async () => ({ document: extractPlain("testo", false) }) });
    const views = [];
    for (let n = 0; n < 9; n += 1) views.push(await files.held.attach(write(`f${n}.txt`, `testo ${n}`)));
    const ids = views.map((view) => view.id);
    await files.held.settle(ids);
    const taken = files.held.take(ids);
    expect(taken.documents).toHaveLength(8);
    expect(taken.leftOut).toEqual([{ id: ids[8], name: "f8.txt", error: "too-many" }]);
  });

  it("fits a photo for the model when it is attached and hands over the copy with the stored original", async () => {
    const copy = { mediaType: "image/jpeg" as const, bytes: new Uint8Array([9, 9, 9]) };
    const { files, write } = setup({ fit: async () => copy });
    const view = await files.held.attach(write("foto.jpg", "pixels"));
    await files.held.settle([view.id]);
    const [photo] = files.held.take([view.id]).photos;
    expect(photo).toMatchObject({ name: "foto.jpg", ext: ".jpg", fitted: copy });
    expect(readFileSync(photo!.file)).toEqual(Buffer.from("pixels"));
  });
});
