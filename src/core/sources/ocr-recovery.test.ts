import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { requests } from "../../shared/ipc";
import { MAX_IMAGE_BASE64 } from "../../shared/source-types";
import { sourceHandlers } from "./handlers";
import type { runSourceWorker } from "./worker-client";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const page = PNG.sync
  .write(new PNG({ width: 8, height: 8 }))
  .toString("base64");

function setup(
  work: ReturnType<typeof vi.fn> = vi.fn(
    async (..._args: unknown[]) => "testo",
  ),
) {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-ocr-recovery-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO sources (id, kind, title, status, mime, created_at, updated_at) VALUES ('scan', 'pdf', 'Scan', 'needs-ocr', 'application/pdf', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'scan', 1, '{"pages":0}', 1)`,
  ).run();
  const start = () =>
    sourceHandlers(
      db,
      workspace,
      undefined,
      undefined,
      work as unknown as typeof runSourceWorker,
    );
  const handlers = start();
  const status = () =>
    (
      db.prepare(`SELECT status FROM sources WHERE id = 'scan'`).get() as {
        status: string;
      }
    ).status;
  const pages = () =>
    (
      db
        .prepare(
          `SELECT json_extract(locator_json, '$.page') AS page FROM passages WHERE source_id = 'scan' ORDER BY page`,
        )
        .all() as Array<{ page: number }>
    ).map((row) => row.page);
  const send = (n: number, last = false) =>
    handlers.ocrImage({ sourceId: "scan", pngBase64: page, page: n, last });
  return { db, handlers, start, status, pages, send };
}

describe("a scan that stops part-way can be started again", () => {
  it("a worker failure on page 2 returns the scan to needs-ocr, keeps page 1, and a retry reads only what is missing", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { handlers, status, pages, send } = setup(work);
    expect(await send(1)).toEqual({ status: "ocr-queued" });
    work.mockRejectedValueOnce(new Error("source-worker-exit"));
    await expect(send(2)).rejects.toMatchObject({
      messageKey: "sources.importFailed",
    });
    expect(status()).toBe("needs-ocr");
    expect(pages()).toEqual([1]);

    work.mockClear();
    expect(await send(1)).toEqual({ status: "ocr-queued" });
    // Page 1 already has its text, so the worker is not asked again.
    expect(work).not.toHaveBeenCalled();
    await send(2);
    expect(await send(3, true)).toEqual({ status: "ready" });
    expect(work).toHaveBeenCalledTimes(2);
    expect(pages()).toEqual([1, 2, 3]);
    expect(status()).toBe("ready");
    expect(handlers.ocrStop({ sourceId: "scan" })).toEqual({ ok: true });
    expect(status()).toBe("ready");
  });

  it("a cancel mid-page returns the scan to needs-ocr and rethrows the abort", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { handlers, status, pages, send } = setup(work);
    await send(1);
    work.mockImplementationOnce(
      (_name: unknown, _input: unknown, signal: unknown) =>
        new Promise<string>((_resolve, reject) =>
          (signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")),
          ),
        ),
    );
    const controller = new AbortController();
    const running = handlers.ocrImage(
      { sourceId: "scan", pngBase64: page, page: 2, last: false },
      controller.signal,
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(status()).toBe("needs-ocr");
    expect(pages()).toEqual([1]);
    await send(1);
    expect(await send(2, true)).toEqual({ status: "ready" });
    expect(pages()).toEqual([1, 2]);
  });

  it("the renderer's stop returns a queued scan to needs-ocr, and never touches a finished, removed or missing source", () => {
    const { db, handlers, status, send } = setup();
    return send(1).then(() => {
      expect(
        requests["sources.ocrStop"].input.safeParse({ sourceId: "scan" })
          .success,
      ).toBe(true);
      expect(handlers.ocrStop({ sourceId: "scan" })).toEqual({ ok: true });
      expect(status()).toBe("needs-ocr");
      // Stopped twice, and for a source that does not exist: no error, no change.
      expect(handlers.ocrStop({ sourceId: "scan" })).toEqual({ ok: true });
      expect(handlers.ocrStop({ sourceId: "nope" })).toEqual({ ok: true });
      for (const state of ["ready", "failed", "removed"]) {
        db.prepare(`UPDATE sources SET status = ? WHERE id = 'scan'`).run(
          state,
        );
        handlers.ocrStop({ sourceId: "scan" });
        expect(status()).toBe(state);
      }
    });
  });

  it("cannot become ready with a page missing: a last page that skips ahead is refused and the scan stays unfinished", async () => {
    const { handlers, status, pages, send } = setup();
    await send(1);
    await expect(send(3, true)).rejects.toMatchObject({
      messageKey: "sources.ocrInterrupted",
      detail: "ocr-out-of-order",
    });
    expect(status()).toBe("ocr-queued");
    expect(pages()).toEqual([1]);
    handlers.ocrStop({ sourceId: "scan" });
    expect(status()).toBe("needs-ocr");
    // A new run must start at page 1.
    await expect(send(2)).rejects.toMatchObject({ detail: "ocr-out-of-order" });
  });

  it("refuses pages for a removed or missing source without changing it", async () => {
    const { db, status, send, handlers } = setup();
    db.prepare(`UPDATE sources SET status = 'removed' WHERE id = 'scan'`).run();
    await expect(send(1, true)).rejects.toMatchObject({
      detail: "ocr-not-active",
    });
    expect(status()).toBe("removed");
    await expect(
      handlers.ocrImage({
        sourceId: "nope",
        pngBase64: page,
        page: 1,
        last: true,
      }),
    ).rejects.toMatchObject({ detail: "source-missing" });
  });

  it("starting core again, or a reloaded window, returns every queued scan to needs-ocr with its pages kept", async () => {
    const { db, start, handlers, status, pages, send } = setup();
    await send(1);
    expect(status()).toBe("ocr-queued");
    start();
    expect(status()).toBe("needs-ocr");
    expect(pages()).toEqual([1]);
    await send(1);
    expect(status()).toBe("ocr-queued");
    handlers.ocrStopAll();
    expect(status()).toBe("needs-ocr");
    // A finished source is left as it is.
    db.prepare(`UPDATE sources SET status = 'ready' WHERE id = 'scan'`).run();
    start();
    expect(status()).toBe("ready");
  });

  it("a page that fails the size, PNG or abort check returns the scan to needs-ocr with its pages kept, and a finished scan is left alone", async () => {
    const { db, status, pages, send, handlers } = setup();
    await send(1);
    expect(status()).toBe("ocr-queued");
    await expect(
      handlers.ocrImage({
        sourceId: "scan",
        pngBase64: Buffer.from("not a png at all").toString("base64"),
        page: 2,
        last: false,
      }),
    ).rejects.toMatchObject({ messageKey: "sources.imageUnsupported" });
    expect(status()).toBe("needs-ocr");
    expect(pages()).toEqual([1]);

    await send(1);
    await expect(
      handlers.ocrImage({
        sourceId: "scan",
        pngBase64: "A".repeat(MAX_IMAGE_BASE64 + 4),
        page: 2,
        last: false,
      }),
    ).rejects.toMatchObject({ messageKey: "sources.tooBig" });
    expect(status()).toBe("needs-ocr");

    await send(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      handlers.ocrImage(
        { sourceId: "scan", pngBase64: page, page: 2, last: false },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(status()).toBe("needs-ocr");
    expect(pages()).toEqual([1]);

    // A late bad page after the scan finished must not undo it.
    await send(1);
    expect(await send(2, true)).toEqual({ status: "ready" });
    await expect(
      handlers.ocrImage({
        sourceId: "scan",
        pngBase64: Buffer.from("junk").toString("base64"),
        page: 3,
        last: false,
      }),
    ).rejects.toMatchObject({ messageKey: "sources.imageUnsupported" });
    expect(status()).toBe("ready");
    expect(pages()).toEqual([1, 2]);
    db.close();
  });

  it("refuses a scan with no stored file before it is queued, whether or not the language data is there", async () => {
    const { db, handlers, status } = setup();
    // The fixture has no stored file, and this workspace has no language data: the file check comes first.
    await expect(handlers.ocr({ sourceId: "scan" })).rejects.toMatchObject({
      messageKey: "sources.fileMissing",
    });
    expect(status()).toBe("needs-ocr");
    // With a stored file the next refusal is the missing data, still before anything is queued.
    db.prepare(`UPDATE sources SET blob_sha = 'abc' WHERE id = 'scan'`).run();
    await expect(handlers.ocr({ sourceId: "scan" })).rejects.toMatchObject({
      messageKey: "sources.ocrDataMissing",
    });
    expect(status()).toBe("needs-ocr");
  });
});

/** A worker call that stays open until the test settles it, like a page still being read when the window reloads. */
function held() {
  let release!: (text: string) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<string>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

/** Lets the held call reach the worker before the test moves on. */
const reachWorker = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a page still being read when the window reloads cannot touch a newer run", () => {
  function holdNext(work: ReturnType<typeof vi.fn>) {
    const call = held();
    work.mockImplementationOnce(() => call.promise);
    return call;
  }
  const nextPage = (db: ReturnType<typeof setup>["db"]) =>
    (
      db
        .prepare(
          `SELECT json_extract(tree_json, '$.ocrNext') AS n FROM source_documents WHERE id = 'doc'`,
        )
        .get() as { n: number | null }
    ).n;

  it("an old page that finishes after a reload and a new run is dropped: nothing written, the new run stays queued and finishes", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { db, handlers, status, pages, send } = setup(work);
    await send(1);
    const old = holdNext(work);
    const stale = send(2);
    const outcome = expect(stale).rejects.toMatchObject({
      messageKey: "sources.ocrInterrupted",
      detail: "ocr-stale",
    });
    await reachWorker();
    handlers.ocrStopAll();
    expect(status()).toBe("needs-ocr");
    expect(await send(1)).toEqual({ status: "ocr-queued" });
    expect(nextPage(db)).toBe(2);
    old.release("vecchio");
    await outcome;
    expect(status()).toBe("ocr-queued");
    expect(nextPage(db)).toBe(2);
    expect(pages()).toEqual([1]);
    expect(await send(2)).toEqual({ status: "ocr-queued" });
    expect(await send(3, true)).toEqual({ status: "ready" });
    expect(pages()).toEqual([1, 2, 3]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM passages WHERE text LIKE '%vecchio%'`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("an old last page cannot finish the scan for the new run", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { db, handlers, status, pages, send } = setup(work);
    await send(1);
    await send(2);
    const old = holdNext(work);
    const stale = send(3, true);
    const outcome = expect(stale).rejects.toMatchObject({
      detail: "ocr-stale",
    });
    await reachWorker();
    handlers.ocrStopAll();
    await send(1);
    old.release("vecchio");
    await outcome;
    expect(status()).toBe("ocr-queued");
    expect(pages()).toEqual([1, 2]);
    expect(nextPage(db)).toBe(2);
  });

  it("when the new run is on the same page, the old read still loses: the run token differs, not just the page", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { handlers, status, pages, db, send } = setup(work);
    await send(1);
    const old = holdNext(work);
    const stale = send(2);
    const staleOutcome = expect(stale).rejects.toMatchObject({
      detail: "ocr-stale",
    });
    await reachWorker();
    handlers.ocrStopAll();
    await send(1);
    // The new run reaches page 2 and is reading it when the old read comes back.
    const fresh = holdNext(work);
    const current = send(2);
    await reachWorker();
    expect(nextPage(db)).toBe(2);
    old.release("vecchio");
    await staleOutcome;
    expect(pages()).toEqual([1]);
    expect(status()).toBe("ocr-queued");
    fresh.release("nuovo");
    expect(await current).toEqual({ status: "ocr-queued" });
    expect(pages()).toEqual([1, 2]);
    const texts = (
      db
        .prepare(
          `SELECT text FROM passages WHERE source_id = 'scan' ORDER BY char_start, text`,
        )
        .all() as Array<{ text: string }>
    ).map((r) => r.text);
    expect(texts).toContain("nuovo");
    expect(texts).not.toContain("vecchio");
  });

  it("an old read that fails late does not stop the run that replaced it", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { handlers, status, pages, send } = setup(work);
    await send(1);
    const old = holdNext(work);
    const stale = send(2);
    const outcome = expect(stale).rejects.toMatchObject({
      messageKey: "sources.importFailed",
    });
    await reachWorker();
    handlers.ocrStopAll();
    await send(1);
    old.fail(new Error("source-worker-exit"));
    await outcome;
    expect(status()).toBe("ocr-queued");
    expect(pages()).toEqual([1]);
    expect(await send(2, true)).toEqual({ status: "ready" });
  });

  it("a read that finishes after the scan was replaced writes nothing into the new document version", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { db, status, pages, send } = setup(work);
    await send(1);
    const old = holdNext(work);
    const stale = send(2);
    const outcome = expect(stale).rejects.toMatchObject({
      detail: "ocr-stale",
    });
    await reachWorker();
    // Replace: a newer version of the document, while the row still reads as queued.
    db.prepare(
      `INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc2', 'scan', 2, '{"pages":0}', 2)`,
    ).run();
    old.release("vecchio");
    await outcome;
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM passages WHERE document_id = 'doc2'`,
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(pages()).toEqual([1]);
    // Version 2 has no page yet, so its own run starts at page 1 once the old one is stopped.
    expect(status()).toBe("ocr-queued");
  });

  it("a refused page changes nothing: page 2 sent first to a stopped scan leaves it needs-ocr, unqueued", async () => {
    const work = vi.fn(async (..._args: unknown[]) => "testo");
    const { db, status, pages, send } = setup(work);
    await expect(send(2)).rejects.toMatchObject({
      messageKey: "sources.ocrInterrupted",
      detail: "ocr-out-of-order",
    });
    await expect(send(3, true)).rejects.toMatchObject({
      detail: "ocr-out-of-order",
    });
    expect(status()).toBe("needs-ocr");
    expect(work).not.toHaveBeenCalled();
    expect(pages()).toEqual([]);
    expect(
      db
        .prepare(`SELECT tree_json FROM source_documents WHERE id = 'doc'`)
        .get(),
    ).toEqual({ tree_json: '{"pages":0}' });
    expect(await send(1)).toEqual({ status: "ocr-queued" });
  });

  it("maps every interruption code to the same plain message", async () => {
    const { db, send } = setup();
    db.prepare(`UPDATE sources SET status = 'removed' WHERE id = 'scan'`).run();
    await expect(send(1)).rejects.toMatchObject({
      messageKey: "sources.ocrInterrupted",
      detail: "ocr-not-active",
    });
  });
});
