import { closeSync, ftruncateSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import type { AttachmentView } from "../../shared/ipc";
import { extractPlain } from "../sources/documents";
import { registerOcrJob, startScan } from "../sources/ocr-job";
import { freeUpSpace } from "../share/usage";
import { sha256 } from "../sources/quality";
import { tempDir } from "../test-temp";
import { createHeldFiles, heldFiles, setHeldFiles } from "./held-files";
import { chatHandlers } from "./handlers";
import { createRunner } from "../jobs/runner";
import { enqueueSourceFile, registerSourceJobs } from "../sources/jobs";
import { heldFilesFor } from "./test-attach";
import { heldMark } from "../sources/jobs";

vi.mock("../sources/jobs", async (original) => {
  const actual = await original<typeof import("../sources/jobs")>();
  return { ...actual, enqueueSourceFile: vi.fn(actual.enqueueSourceFile) };
});

/** Holds the next registration of a document until `release`, then runs it, or fails it with `fail`. */
function holdRegistration(fail?: Error) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run = vi.mocked(enqueueSourceFile).getMockImplementation()!;
  vi.mocked(enqueueSourceFile).mockImplementationOnce(async (...args) => {
    await gate;
    if (fail) throw fail;
    return run(...args);
  });
  return release;
}

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
    expect((await t.files.held.settle([view.id]), t.files.held.take([view.id]).leftOut)).toEqual([{ id: view.id, name: "scansione.pdf", kind: "document", error: "data" }]);
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

  it("leaves no finished reading in the jobs list after its file is taken off, for a document and for a scan", async () => {
    const t = setup({
      extract: scanned(2),
      scan: async (id) => {
        startScan(t.db, t.files.runner, id);
        return "started";
      },
    });
    registerOcrJob(t.db, t.workspace, t.files.runner, {
      readPages: async (_path, wanted) => ({ count: 2, pages: wanted.filter((page) => page <= 2).map((page) => ({ page, text: `Pagina ${page}` })) }),
      requireData: async () => {},
      onReady: () => {},
    });
    const view = await t.files.held.attach(t.write("scansione.pdf", "%PDF"));
    await until(() => t.last(view.id)?.state === "ready");
    // Both jobs ended well. The source goes with its chip, and the finished jobs must not turn up in Attività then.
    expect(t.db.prepare(`SELECT COUNT(*) FROM jobs WHERE state = 'succeeded'`).pluck().get()).toBe(2);
    t.files.held.detach(view.id);
    await until(() => t.sources().length === 0);
    expect(t.files.runner.finished()).toEqual([]);
    expect(t.files.runner.list()).toEqual([]);
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
    expect(taken.leftOut).toEqual([{ id: bad.id, name: "rotto.txt", kind: "document", error: "unreadable" }]);
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

  it("stops waiting for a photo being fitted when the turn is stopped, and the photo's own work goes on", async () => {
    let finish: (image: { mediaType: "image/png"; bytes: Uint8Array }) => void = () => {};
    const { files, write } = setup({ fit: () => new Promise((resolve) => (finish = resolve)) });
    const view = await files.held.attach(write("foto.png", "pixels"));
    const controller = new AbortController();
    const waiting = files.held.settle([view.id], controller.signal);
    // The signal fires while the photo is still being fitted, and a stop must not wait for the fitting to end.
    setTimeout(() => controller.abort(), 10);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    // The photo stays held and is fitted in the background: the composer still has it, ready, for the retry.
    expect(files.held.list([view.id])[0]).toMatchObject({ state: "reading" });
    finish({ mediaType: "image/png", bytes: new Uint8Array([1]) });
    await files.held.settle([view.id]);
    expect(files.held.list([view.id])[0]).toMatchObject({ state: "ready" });
  });

  it("carries at most eight files, and names the ones past them", async () => {
    const { files, write } = setup({ extract: async () => ({ document: extractPlain("testo", false) }) });
    const views = [];
    for (let n = 0; n < 9; n += 1) views.push(await files.held.attach(write(`f${n}.txt`, `testo ${n}`)));
    const ids = views.map((view) => view.id);
    await files.held.settle(ids);
    const taken = files.held.take(ids);
    expect(taken.documents).toHaveLength(8);
    expect(taken.leftOut).toEqual([{ id: ids[8], name: "f8.txt", kind: "document", error: "too-many" }]);
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

describe("cleanup sees the files a composer holds", () => {
  it("keeps a held document and a held photo through Free up space, and removes them once they are taken off", async () => {
    const { files, write, workspace, db, sources } = setup({ fit: async () => ({ mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) }) });
    const note = write("appunti.txt", "Il calore si trasmette per conduzione.");
    const photo = write("foto.png", "pixels");
    const doc = await files.held.attach(note);
    const pic = await files.held.attach(photo);
    await files.held.settle([doc.id, pic.id]);
    const photoSha = sha256(readFileSync(photo));
    // The student opens Settings and frees up space before sending anything.
    freeUpSpace(db, workspace);
    expect(sources()).toEqual([expect.objectContaining({ library: 0, status: "ready" })]);
    expect(hasBlob(workspace, photoSha)).toBe(true);
    expect(files.held.list([doc.id, pic.id]).map((view) => view.state)).toEqual(["ready", "ready"]);
    files.held.detach(doc.id);
    files.held.detach(pic.id);
    freeUpSpace(db, workspace);
    expect(sources()).toEqual([]);
    expect(hasBlob(workspace, photoSha)).toBe(false);
  });

  it("keeps the stored file of a photo while another held copy of it is there", async () => {
    const { files, write, workspace } = setup({ fit: async () => ({ mediaType: "image/png", bytes: new Uint8Array([1]) }) });
    const photo = write("foto.png", "gli stessi pixel");
    const sha = sha256(readFileSync(photo));
    const first = await files.held.attach(photo);
    const second = await files.held.attach(photo);
    await files.held.settle([first.id, second.id]);
    files.held.detach(first.id);
    expect(hasBlob(workspace, sha)).toBe(true);
    expect(files.held.take([second.id]).photos[0]!.file).toBeTruthy();
    files.held.detach(second.id);
    expect(hasBlob(workspace, sha)).toBe(false);
  });
});

describe("every held file is recorded in the database", () => {
  const png = { mediaType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };

  it("records a document and a photo from the moment they are attached: draft, hidden source, stored file, state", async () => {
    const { files, write, db, sources } = setup({ fit: async () => png });
    const doc = await files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."), "chat-a");
    const pic = await files.held.attach(write("foto.png", "pixels"), "chat-b");
    const rows = () =>
      db.prepare(`SELECT id, draft, name, kind, state, source_id, blob_sha FROM held_files ORDER BY created_at, rowid`).all();
    expect(rows()).toEqual([
      expect.objectContaining({ id: doc.id, draft: "chat-a", name: "appunti.txt", kind: "document", source_id: sources()[0]!.id, blob_sha: null }),
      expect.objectContaining({ id: pic.id, draft: "chat-b", name: "foto.png", kind: "photo", source_id: null, blob_sha: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    await files.held.settle([doc.id, pic.id]);
    expect(rows().map((row) => (row as { state: string }).state)).toEqual(["ready", "ready"]);
    // Sent: the question's rows name the files, and the held rows go with the question's answer.
    db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'q', 1)`).run();
    db.prepare(
      `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at, name, kind, size, source_id)
       SELECT 'a1', 'm', blob_sha, 'text/plain', 1, 'appunti.txt', 'document', 1, id FROM sources`,
    ).run();
    db.prepare(`INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) SELECT 'a2', 'm', blob_sha, 'image/png', 1 FROM held_files WHERE kind = 'photo'`).run();
    files.held.tie([doc.id, pic.id], "m");
    files.held.finishSend("m");
    expect(rows()).toEqual([]);
    expect(sources()).toHaveLength(1);
  });

  it("removes the import job's extracted-text blob when a file is taken off", async () => {
    const { files, write, db, workspace } = setup();
    const view = await files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."));
    await files.held.settle([view.id]);
    const extracted = db
      .prepare(`SELECT json_extract(params_json, '$.extractedSha') FROM jobs WHERE kind = 'source-import'`)
      .pluck()
      .get() as string;
    expect(hasBlob(workspace, extracted)).toBe(true);
    files.held.detach(view.id);
    expect(hasBlob(workspace, extracted)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
  });

  it("removes at start what the last run left held: documents, their blobs and photo originals up to 40 MB", async () => {
    const { files, write, db, workspace, sources } = setup({ fit: async () => png });
    const doc = await files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."));
    const photoPath = write("foto.png", "pixels di una foto abbandonata");
    const pic = await files.held.attach(photoPath);
    await files.held.settle([doc.id, pic.id]);
    const photoSha = sha256(readFileSync(photoPath));
    expect(hasBlob(workspace, photoSha)).toBe(true);
    // The app quit: nothing holds them in memory any more. The next run starts and sweeps what the table still lists.
    const next = createHeldFiles({ db, workspace, runner: files.runner, emit: () => {} });
    next.sweep();
    expect(sources()).toEqual([]);
    expect(hasBlob(workspace, photoSha)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
  });

  it("leaves what the running composer holds alone when it sweeps", async () => {
    const { files, write, db, sources } = setup();
    const view = await files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."));
    await files.held.settle([view.id]);
    files.held.sweep();
    expect(sources()).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(1);
  });

  it("keeps a source and its passages that a stored question names when its held row goes", async () => {
    const { files, write, db, sources } = setup();
    const view = await files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."));
    await files.held.settle([view.id]);
    const [source] = sources();
    db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)`).run();
    db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'q', 1)`).run();
    db.prepare(
      `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at, name, kind, size, source_id)
       SELECT 'a', 'm', blob_sha, 'text/plain', 1, 'appunti.txt', 'document', 10, id FROM sources WHERE id = ?`,
    ).run(source!.id);
    files.held.detach(view.id);
    expect(sources()).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) FROM passages WHERE source_id = ?`).pluck().get(source!.id)).toBeGreaterThan(0);
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
  });

  it("releases the unsent files of a chat that is deleted, whatever the send that held them did", async () => {
    const workspace = tempDir("pyxis-held-delete-");
    const db = openDatabase(join(workspace, "pyxis.db"));
    opened.push(db);
    // The app's wiring: the runner's updates reach the running composer.
    const runner = createRunner(db, (job) => heldFiles()?.onJob(job));
    registerSourceJobs(db, workspace, runner, async () => ({ document: extractPlain("Il calore si trasmette per conduzione.", false) }));
    const handlers = chatHandlers(db, workspace, undefined, 0, undefined, { runner, emit: () => {} });
    db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1), ('altra', 't', 1, 1)`).run();
    const path = join(workspace, "appunti.txt");
    writeFileSync(path, "Il calore si trasmette per conduzione.");
    const view = await handlers.attach({ path, draft: "c" });
    const other = await handlers.attach({ path, draft: "altra" });
    for (let i = 0; i < 200 && db.prepare(`SELECT COUNT(*) FROM sources WHERE status = 'ready'`).pluck().get() !== 2; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    handlers.remove({ chatId: "c" });
    expect(handlers.attachments({ ids: [view.id, other.id] }).map((item) => item.id)).toEqual([other.id]);
    expect(db.prepare(`SELECT draft FROM held_files`).pluck().all()).toEqual(["altra"]);
    expect(db.prepare(`SELECT COUNT(*) FROM sources`).pluck().get()).toBe(1);
    // A pick that was still registering when the chat went is refused: no source is made for a draft that no longer exists.
    await expect(handlers.attach({ path, draft: "c" })).rejects.toMatchObject({ code: "chat-missing" });
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) FROM sources`).pluck().get()).toBe(1);
    setHeldFiles(null);
  });
});

describe("a file attached to a chat that is removed while it is being registered", () => {
  it("is refused, and leaves no held file, source or stored file for a chat that is gone", async () => {
    const { db, workspace, sources, write } = setup();
    // The app's wiring: the runner's updates reach the running composer.
    const runner = createRunner(db, (job) => heldFiles()?.onJob(job));
    registerSourceJobs(db, workspace, runner, async () => ({ document: extractPlain("Il calore si trasmette per conduzione.", false) }));
    const handlers = chatHandlers(db, workspace, undefined, 0, undefined, { runner, emit: () => {} });
    for (const [name, content] of [["appunti.txt", "Il calore si trasmette per conduzione."], ["foto.png", "x"]] as const) {
      db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('vuota', 't', 1, 1)`).run();
      const path = write(name, content);
      // The pick has passed the chat's check and is still reading the file when the student leaves the empty chat.
      const picked = handlers.attach({ path, draft: "vuota" });
      handlers.leave({ chatId: "vuota" });
      await expect(picked).rejects.toMatchObject({ code: "chat-missing" });
      expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
      await until(() => sources().length === 0);
      await until(() => !hasBlob(workspace, sha256(readFileSync(path))));
    }
    setHeldFiles(null);
  });
});

describe("a photo that cannot be read fails on its chip", () => {
  it("tells a valid photo that needs OCR from one that is corrupt: the corrupt one fails when it is attached", async () => {
    const reasons: Record<string, string> = { "grande.webp": "vision-image-too-large", "rotto.heic": "heic-invalid", "strano.png": "vision-image-unsupported" };
    const { files, write } = setup({
      fit: async (file) => {
        throw new Error(reasons[readFileSync(file, "utf8")]!);
      },
    });
    const views = [];
    for (const name of Object.keys(reasons)) views.push(await files.held.attach(write(name, name)));
    await files.held.settle(views.map((view) => view.id));
    expect(files.held.list(views.map((view) => view.id)).map((view) => [view.name, view.state, view.error])).toEqual([
      ["grande.webp", "ready", undefined],
      ["rotto.heic", "failed", "unreadable"],
      ["strano.png", "failed", "unreadable"],
    ]);
    // The question still goes out: the unreadable ones are named, the valid one is read locally.
    const taken = files.held.take(views.map((view) => view.id));
    expect(taken.photos.map((photo) => photo.name)).toEqual(["grande.webp"]);
    expect(taken.leftOut.map((file) => [file.name, file.error])).toEqual([
      ["rotto.heic", "unreadable"],
      ["strano.png", "unreadable"],
    ]);
  });
});

describe("a photo the decoder refuses for its size", () => {
  it("fails on its chip when it is attached, since the local reading would decode it with the same limit; a photo only past the provider's limit stays ready", async () => {
    const reasons: Record<string, string> = { "enorme.jpg": "vision-image-decode-limit", "grande.webp": "vision-image-too-large" };
    const { files, write } = setup({
      fit: async (file) => {
        throw new Error(reasons[readFileSync(file, "utf8")]!);
      },
    });
    const views = [];
    for (const name of Object.keys(reasons)) views.push(await files.held.attach(write(name, name)));
    await files.held.settle(views.map((view) => view.id));
    expect(files.held.list(views.map((view) => view.id)).map((view) => [view.name, view.state, view.error])).toEqual([
      ["enorme.jpg", "failed", "picture-too-large"],
      ["grande.webp", "ready", undefined],
    ]);
    // The message goes out without the first and names it, as for any file that cannot be read.
    const taken = files.held.take(views.map((view) => view.id));
    expect(taken.leftOut.map((file) => [file.name, file.error])).toEqual([["enorme.jpg", "picture-too-large"]]);
    expect(taken.photos.map((photo) => photo.name)).toEqual(["grande.webp"]);
  });
});

describe("a photo is never reading with nothing running", () => {
  const png = { mediaType: "image/png" as const, bytes: new Uint8Array([1, 2, 3]) };

  it("holds a photo as reading only while its fitting is under way, and ends every photo as ready or failed", async () => {
    // One fitting is held until the test lets it go; the others end at once, one fitted and three refused.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const outcomes: Record<string, () => Promise<typeof png>> = {
      "subito.jpg": async () => png,
      "attesa.jpg": async () => (await gate, png),
      "rifiutata.jpg": () => Promise.reject(new Error("vision-image-unsupported")),
      "troppo-grande.jpg": () => Promise.reject(new Error("vision-image-too-large")),
      "senza-parole.jpg": () => Promise.reject(new Error("")),
    };
    const inFlight = new Set<string>();
    const reading: Array<{ name: string; fitting: boolean }> = [];
    const events: AttachmentView[] = [];
    const { files, write } = setup({
      fit: async (file) => {
        const name = readFileSync(file, "utf8");
        inFlight.add(name);
        try {
          return await outcomes[name]!();
        } finally {
          inFlight.delete(name);
        }
      },
      // Every view core announces as reading is checked at that moment: its fitting must be under way.
      emit: (view) => {
        events.push(view);
        if (view.state === "reading") reading.push({ name: view.name, fitting: inFlight.has(view.name) });
      },
    });
    const views: AttachmentView[] = [];
    for (const name of Object.keys(outcomes)) views.push(await files.held.attach(write(name, name)));
    const held = views.find((view) => view.name === "attesa.jpg")!;
    const others = views.filter((view) => view !== held).map((view) => view.id);
    await files.held.settle(others);

    // While the gated fitting is held, its photo is reading and its fitting is under way; every other photo has ended.
    expect(files.held.list([held.id])[0]).toMatchObject({ state: "reading" });
    expect(inFlight.has("attesa.jpg")).toBe(true);
    expect(files.held.list(others).map((view) => [view.name, view.state])).toEqual([
      ["subito.jpg", "ready"],
      ["rifiutata.jpg", "failed"],
      ["troppo-grande.jpg", "ready"],
      ["senza-parole.jpg", "failed"],
    ]);

    // Let it go: the photo ends ready, nothing is left under way, and the window was told.
    release();
    await files.held.settle([held.id]);
    expect(files.held.list([held.id])[0]).toMatchObject({ state: "ready" });
    expect(inFlight.size).toBe(0);
    expect(events.filter((event) => event.id === held.id).at(-1)).toMatchObject({ state: "ready" });
    for (const view of views) expect(["ready", "failed"], view.name).toContain(events.filter((event) => event.id === view.id).at(-1)?.state);
    // No view said reading while nothing was fitting.
    expect(reading.length).toBeGreaterThan(0);
    expect(reading.every((entry) => entry.fitting), JSON.stringify(reading)).toBe(true);
  });
});

describe("a scan whose indexing failed is still read", () => {
  it("starts reading the scan when the import ended on its indexing step, and does not wait for ever", async () => {
    const t = setup({
      extract: scanned(2),
      jobDeps: {
        onScan: () => {
          throw new Error("index failed");
        },
      },
      scan: async (id) => {
        startScan(t.db, t.files.runner, id);
        return "started";
      },
    });
    registerOcrJob(t.db, t.workspace, t.files.runner, {
      readPages: async (_path, wanted) => ({ count: 2, pages: wanted.filter((page) => page <= 2).map((page) => ({ page, text: `Pagina ${page}` })) }),
      requireData: async () => {},
      onReady: () => {},
    });
    const view = await t.files.held.attach(t.write("scansione.pdf", "%PDF"));
    await until(() => t.last(view.id)?.state === "ready");
    expect(t.db.prepare(`SELECT state FROM jobs WHERE kind = 'source-import'`).pluck().get()).toBe("failed");
  });
});

describe("the index job of a held scan belongs to its chip too", () => {
  it("is out of the jobs list and goes with the file when it is taken off, queued or failed", async () => {
    const { files, write, db, workspace, sources } = setup();
    const runner = files.runner;
    runner.register("source-index", {
      jobClass: "local",
      unlisted: (params: unknown) => (params as { held?: boolean }).held === true,
      steps: [{ name: "index", label: "x", run: async (ctx: { signal: AbortSignal }) => new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(new DOMException("a", "AbortError")))) }],
    });
    const view = await files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."));
    await files.held.settle([view.id]);
    const [source] = sources();
    const job = runner.start("source-index", { sourceId: source!.id, ...heldMark(db, source!.id) });
    expect(runner.list()).toEqual([]);
    expect(db.prepare(`SELECT json_extract(params_json, '$.held') FROM jobs WHERE id = ?`).pluck().get(job)).toBe(1);
    files.held.detach(view.id);
    await until(() => sources().length === 0);
    expect(db.prepare(`SELECT dismissed FROM jobs WHERE id = ?`).pluck().get(job)).toBeGreaterThan(0);
    expect(workspace).toBeTruthy();
  });
});

describe("a held document that the student cancelled is a terminal state", () => {
  it("shows it was stopped, leaves it out of the send and names it, and starts no scan", async () => {
    let scans = 0;
    const t = setup({
      extract: scanned(2),
      jobDeps: {
        // The student cancels the import while it is on its last step: its passages are stored and it is back at `needs-ocr`.
        onScan: (id: string) => {
          const job = t.db.prepare(`SELECT id FROM jobs WHERE kind = 'source-import'`).pluck().get() as string;
          t.files.runner.cancel(job);
          void id;
        },
      },
      scan: async () => {
        scans += 1;
        return "started";
      },
    });
    const view = await t.files.held.attach(t.write("scansione.pdf", "%PDF"));
    await until(() => t.last(view.id)?.state === "failed");
    expect(t.last(view.id)).toMatchObject({ state: "failed", error: "cancelled" });
    await t.files.held.settle([view.id]);
    expect(t.files.held.take([view.id]).leftOut).toEqual([expect.objectContaining({ name: "scansione.pdf", error: "cancelled" })]);
    expect(scans).toBe(0);
  });
});

describe("an import that finishes after its draft was removed", () => {
  it("leaves no source, stored file or job behind", async () => {
    const { files, db, workspace, sources } = setup();
    const big = join(workspace, "grande.txt");
    writeFileSync(big, "Il calore si trasmette per conduzione.");
    // The registration is held until the draft has gone.
    const release = holdRegistration();
    const picked = files.held.attach(big, "chat-a");
    await until(() => db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get() === 1);
    files.held.discardDraft("chat-a");
    release();
    const view = await picked;
    expect(view).toMatchObject({ state: "failed", error: "cancelled" });
    await until(() => sources().length === 0);
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) FROM jobs WHERE dismissed = 0 AND state IN ('queued', 'running')`).pluck().get()).toBe(0);
    expect(hasBlob(workspace, sha256(readFileSync(big)))).toBe(false);
  });
});

describe("a registration that fails after its draft was removed", () => {
  it("is cancelled, and leaves no failed chip or held row for the draft that is gone", async () => {
    const { files, db, write, events } = setup();
    const release = holdRegistration(new Error("disk full"));
    const picked = files.held.attach(write("appunti.txt", "Il calore si trasmette per conduzione."), "chat-a");
    await until(() => db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get() === 1);
    files.held.discardDraft("chat-a");
    release();
    const view = await picked;
    expect(view).toMatchObject({ state: "failed", error: "cancelled" });
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
    expect(files.held.list([view.id])).toEqual([]);
    expect(events.filter((event) => event.id === view.id && event.state === "failed")).toEqual([]);
  });
});

describe("a file left out says what kind of file it was", () => {
  it("carries the kind, so an oversized photo gets the photo's limit", async () => {
    const { files, workspace } = setup();
    const huge = join(workspace, "enorme.jpg");
    writeFileSync(huge, "x");
    const fd = openSync(huge, "r+");
    ftruncateSync(fd, 41 * 1024 * 1024);
    closeSync(fd);
    const view = await files.held.attach(huge);
    expect(files.held.take([view.id]).leftOut).toEqual([{ id: view.id, name: "enorme.jpg", kind: "photo", error: "too-large" }]);
  });
});
