import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { putBlob } from "../blobs";
import { createRunner } from "../jobs/runner";
import { tempDir } from "../test-temp";
import { registerOcrJob, startScan, stopOrphanScans, waitingScans, type ScanDeps } from "./ocr-job";
import { requestOcr } from "./ocr";

const opened: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

/** A scanned PDF of `count` pages, already through import: a document with no passages, waiting for OCR. */
function scan(count = 20) {
  const workspace = tempDir("pyxis-ocr-job-");
  const db = openDatabase(join(workspace, "pyxis.db"));
  opened.push(db);
  const sha = putBlob(workspace, new TextEncoder().encode("%PDF-1.7 synthetic"), "application/pdf", ".pdf");
  db.prepare(
    `INSERT INTO sources (id, kind, title, blob_sha, status, mime, created_at, updated_at)
     VALUES ('scan', 'pdf', 'Analisi', ?, 'needs-ocr', 'application/pdf', 1, 1)`,
  ).run(sha);
  db.prepare(
    `INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'scan', 1, '{}', 1)`,
  ).run();
  const status = () =>
    (db.prepare(`SELECT status FROM sources WHERE id = 'scan'`).get() as { status: string }).status;
  const pages = () =>
    (
      db
        .prepare(
          `SELECT DISTINCT json_extract(locator_json, '$.page') AS page FROM passages WHERE source_id = 'scan' ORDER BY page`,
        )
        .all() as Array<{ page: number }>
    ).map((row) => row.page);
  return { workspace, db, status, pages, count };
}

/** A page reader that reads every page it is asked for, unless `stop` says otherwise, and records the batches. */
function reader(count: number, stop?: (pages: number[], call: number) => Promise<void> | void) {
  const batches: number[][] = [];
  const readPages: ScanDeps["readPages"] = async (_path, pages, signal) => {
    batches.push(pages);
    await stop?.(pages, batches.length);
    signal.throwIfAborted();
    return {
      count,
      pages: pages.filter((page) => page <= count).map((page) => ({ page, text: `Testo della pagina ${page}` })),
    };
  };
  return { readPages, batches };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout");
}

function start(
  fixture: ReturnType<typeof scan>,
  readPages: ScanDeps["readPages"],
  extra: Partial<ScanDeps> = {},
) {
  const progress: number[] = [];
  const runner = createRunner(fixture.db, (job) => {
    if (job.kind === "source-ocr") progress.push(job.progress);
  });
  const ready: string[] = [];
  registerOcrJob(fixture.db, fixture.workspace, runner, {
    readPages,
    requireData: async () => {},
    onReady: (sourceId) => ready.push(sourceId),
    ...extra,
  });
  // The jobs list leaves finished jobs out, so the state is read from the table.
  const state = (jobId: string) =>
    (fixture.db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(jobId) as { state: string } | undefined)?.state;
  return { runner, progress, ready, state };
}

describe("reading a scan in core", () => {
  it("reads every page in batches, moves the bar, and ends ready with each page's text", async () => {
    const fixture = scan(20);
    const { readPages, batches } = reader(20);
    const { runner, progress, ready, state } = start(fixture, readPages);
    const jobId = startScan(fixture.db, runner, "scan");
    // The list shows the scan reading before the first page is back.
    expect(fixture.status()).toBe("ocr-queued");
    await until(() => state(jobId) === "succeeded");
    expect(fixture.status()).toBe("ready");
    expect(fixture.pages()).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(batches).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [9, 10, 11, 12, 13, 14, 15, 16],
      [17, 18, 19, 20],
    ]);
    expect(progress).toContain(0.4);
    expect(progress).toContain(0.8);
    expect(ready).toEqual(["scan"]);
  });

  it("a failed batch stops with the pages read kept, and reading again asks only for the missing pages", async () => {
    const fixture = scan(20);
    const { readPages, batches } = reader(20, (_pages, call) => {
      if (call === 2) throw new Error("source-worker-memory");
    });
    const { runner, state } = start(fixture, readPages);
    const first = startScan(fixture.db, runner, "scan");
    await until(() => state(first) === "failed");
    expect(runner.list().find((job) => job.id === first)?.error).toBe("source-worker-memory");
    expect(fixture.status()).toBe("needs-ocr");
    expect(fixture.pages()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const second = startScan(fixture.db, runner, "scan");
    await until(() => state(second) === "succeeded");
    expect(fixture.status()).toBe("ready");
    expect(batches.slice(2)).toEqual([
      [9, 10, 11, 12, 13, 14, 15, 16],
      [17, 18, 19, 20],
    ]);
  });

  it("a cancel stops between pages, keeps what was read, and puts the scan back to needs-ocr", async () => {
    const fixture = scan(20);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { readPages } = reader(20, (_pages, call) => (call === 2 ? held : undefined));
    const { runner, state } = start(fixture, readPages);
    const jobId = startScan(fixture.db, runner, "scan");
    await until(() => fixture.pages().length === 8);
    runner.cancel(jobId);
    release();
    await until(() => state(jobId) === "cancelled");
    expect(fixture.status()).toBe("needs-ocr");
    expect(fixture.pages()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("a quit mid-scan resumes at the next start from the first page without text, also after a second quit", async () => {
    const fixture = scan(20);
    // The first process dies during its second batch: the promise never settles, as when the app quits.
    const first = start(fixture, reader(20, (_pages, call) => (call === 2 ? new Promise(() => {}) : undefined)).readPages);
    const jobId = startScan(fixture.db, first.runner, "scan");
    await until(() => fixture.pages().length === 8);
    // A second start over the same database marks the running job interrupted, as after a quit.
    const restart = (stop?: (pages: number[], call: number) => Promise<void> | void) => {
      stopOrphanScans(fixture.db);
      const read = reader(20, stop);
      const next = start(fixture, read.readPages);
      next.runner.resumeLocal(["source-ocr"]);
      return { ...next, batches: read.batches };
    };
    const second = restart((_pages, call) => (call === 2 ? new Promise(() => {}) : undefined));
    // The scan kept waiting for its job instead of going back to needs-ocr.
    expect(fixture.status()).toBe("ocr-queued");
    await until(() => fixture.pages().length === 16);
    expect(second.batches[0]).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    // It stored pages, so a second quit resumes it by itself too.
    const third = restart();
    await until(() => third.state(jobId) === "succeeded");
    // A resumed run learns the page count from its first batch, so it asks for a full batch and gets pages 17 to 20.
    expect(third.batches).toEqual([[17, 18, 19, 20, 21, 22, 23, 24]]);
    expect(fixture.pages()).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(fixture.status()).toBe("ready");
  });

  it("a scan that dies again before storing a page waits for the student instead of looping", async () => {
    const fixture = scan(20);
    const hang = () => new Promise<void>(() => {});
    const first = start(fixture, reader(20, hang).readPages);
    const jobId = startScan(fixture.db, first.runner, "scan");
    await until(() => first.state(jobId) === "running");
    const second = start(fixture, reader(20, hang).readPages);
    expect(second.runner.resumeLocal(["source-ocr"])).toEqual([jobId]);
    await until(() => second.state(jobId) === "running");
    const third = start(fixture, reader(20).readPages);
    expect(third.runner.resumeLocal(["source-ocr"])).toEqual([]);
    expect(third.state(jobId)).toBe("interrupted");
    // Pressing Read the scan resumes the same job.
    expect(startScan(fixture.db, third.runner, "scan")).toBe(jobId);
    await until(() => third.state(jobId) === "succeeded");
    expect(fixture.status()).toBe("ready");
  });

  it("a batch read for a run that was replaced meanwhile writes nothing", async () => {
    const fixture = scan(20);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { readPages } = reader(20, (_pages, call) => (call === 1 ? held : undefined));
    const { runner, state } = start(fixture, readPages);
    const jobId = startScan(fixture.db, runner, "scan");
    await until(() => state(jobId) === "running");
    // Another run takes the source over, as a replaced file starting its own scan would.
    fixture.db.prepare(`UPDATE sources SET status = 'needs-ocr' WHERE id = 'scan'`).run();
    requestOcr(fixture.db, "scan");
    release();
    await until(() => state(jobId) === "failed");
    expect(runner.list().find((job) => job.id === jobId)?.error).toBe("ocr-stale");
    expect(fixture.pages()).toEqual([]);
    // The newer run still owns the source.
    expect(fixture.status()).toBe("ocr-queued");
  });

  it("joins the run already going instead of starting a second one", () => {
    const fixture = scan(20);
    const { runner } = start(fixture, reader(20, () => new Promise(() => {})).readPages);
    const jobId = startScan(fixture.db, runner, "scan");
    expect(startScan(fixture.db, runner, "scan")).toBe(jobId);
  });

  it("refuses a scan whose file is gone or whose OCR data is missing, and puts it back to needs-ocr", async () => {
    const fixture = scan(20);
    const { runner, state } = start(fixture, reader(20).readPages, {
      requireData: async () => {
        throw new Error("ocr-data-missing");
      },
    });
    const jobId = startScan(fixture.db, runner, "scan");
    await until(() => state(jobId) === "failed");
    expect(runner.list().find((job) => job.id === jobId)?.error).toBe("ocr-data-missing");
    expect(fixture.status()).toBe("needs-ocr");
    fixture.db.prepare(`UPDATE sources SET blob_sha = ? WHERE id = 'scan'`).run("0".repeat(64));
    const again = startScan(fixture.db, runner, "scan");
    await until(() => state(again) === "failed");
    expect(runner.list().find((job) => job.id === again)?.error).toBe("source-file-missing");
  });

  it("at startup, a scan queued without a job goes back to needs-ocr, and lists the scans waiting for text", () => {
    const fixture = scan(20);
    requestOcr(fixture.db, "scan");
    stopOrphanScans(fixture.db);
    expect(fixture.status()).toBe("needs-ocr");
    expect(waitingScans(fixture.db)).toEqual(["scan"]);
    fixture.db.prepare(`UPDATE sources SET blob_sha = NULL WHERE id = 'scan'`).run();
    expect(waitingScans(fixture.db)).toEqual([]);
  });

  it("a scan where no page has text ends failed, so the Library offers it again", async () => {
    const fixture = scan(3);
    const { runner, state } = start(fixture, async (_path, pages) => ({
      count: 3,
      pages: pages.map((page) => ({ page, text: "" })),
    }));
    const jobId = startScan(fixture.db, runner, "scan");
    await until(() => state(jobId) === "succeeded");
    expect(fixture.status()).toBe("failed");
  });
});
