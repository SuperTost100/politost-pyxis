import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { IpcError } from "../../shared/ipc";
import { sourceHandlers } from "./handlers";
import { OCR_DATA_FILES, ocrDataDir } from "./ocr-data";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const pinned =
  process.env.PYXIS_TEST_TESSDATA ??
  join(import.meta.dirname, "../../../.tmp/tessdata-fast");
const haveData =
  existsSync(join(pinned, "eng.traineddata")) &&
  existsSync(join(pinned, "ita.traineddata"));
const totalBytes = Object.values(OCR_DATA_FILES).reduce(
  (sum, file) => sum + file.size,
  0,
);

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-ocr-handlers-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const runner = createRunner(db, () => {});
  // No vision engine is chosen, so a photo would be read by local OCR.
  const handlers = sourceHandlers(db, workspace, runner);
  const path = join(workspace, "note.png");
  writeFileSync(path, PNG.sync.write(new PNG({ width: 8, height: 8 })));
  const fetchSpy = vi.fn(async () => new Response("unexpected"));
  vi.stubGlobal("fetch", fetchSpy);
  const tess = join(workspace, "runtimes", "tesseract");
  return { workspace, db, runner, handlers, path, fetchSpy, tess };
}
const job = (runner: ReturnType<typeof createRunner>, id: string) =>
  runner.list().find((item) => item.id === id);
const state = (runner: ReturnType<typeof createRunner>, id: string) => () =>
  job(runner, id)?.state;

describe("SRC-04 / ASK-04 local OCR data: consent, job, and clear refusals", () => {
  it("reports disk truth and the saved answer, and never downloads on its own", async () => {
    const { handlers, fetchSpy } = setup();
    expect(await handlers.ocrDataState()).toEqual({
      consent: false,
      state: "missing",
      totalBytes,
      languages: ["eng", "ita"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a photo that local OCR must read while the data is missing, before any row or job exists", async () => {
    const { handlers, db, runner, path, fetchSpy } = setup();
    await expect(handlers.importFile({ path })).rejects.toMatchObject({
      messageKey: "sources.ocrDataMissing",
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({
      n: 0,
    });
    expect(runner.list()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says `integrity` for a file that is there but altered", async () => {
    const { handlers, path, tess } = setup();
    mkdirSync(ocrDataDir(tess), { recursive: true });
    writeFileSync(join(ocrDataDir(tess), "eng.traineddata"), "tampered");
    await expect(handlers.importFile({ path })).rejects.toMatchObject({
      messageKey: "sources.ocrDataIntegrity",
    });
    expect(await handlers.ocrDataState()).toMatchObject({ state: "integrity" });
  });

  it("refuses scanned-PDF OCR before queuing a page, and re-extract of a photo, with the same message", async () => {
    const { handlers, db } = setup();
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, mime, blob_sha, created_at, updated_at) VALUES ('scan', 'pdf', 'Scan', 'needs-ocr', 'application/pdf', ?, 1, 1)`,
    ).run("b".repeat(64));
    await expect(handlers.ocr({ sourceId: "scan" })).rejects.toBeInstanceOf(
      IpcError,
    );
    await expect(handlers.ocr({ sourceId: "scan" })).rejects.toMatchObject({
      messageKey: "sources.ocrDataMissing",
    });
    expect(
      db.prepare(`SELECT status FROM sources WHERE id = 'scan'`).get(),
    ).toEqual({ status: "needs-ocr" });
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, mime, blob_sha, created_at, updated_at) VALUES ('photo', 'image', 'Foto', 'ready', 'image/png', ?, 1, 1)`,
    ).run("a".repeat(64));
    await expect(
      handlers.reextract({ sourceId: "photo", confirmed: true }),
    ).rejects.toMatchObject({ messageKey: "sources.ocrDataMissing" });
  });

  it("saves a refusal without starting a job, and a job that runs without consent downloads nothing", async () => {
    const { handlers, runner, fetchSpy } = setup();
    expect(await handlers.ocrData({ consent: false })).toEqual({
      state: "off",
    });
    expect(runner.list()).toEqual([]);
    const id = runner.start("ocr-data-download");
    await expect.poll(state(runner, id)).toBe("failed");
    expect(job(runner, id)?.error).toBe("ocr-data-declined");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("downloads after consent as one durable job: progress per language, offline error, and a retry that finishes", async () => {
    const { handlers, runner, fetchSpy, tess } = setup();
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    const started = await handlers.ocrData({ consent: true });
    expect(started).toMatchObject({ state: "missing" });
    const id = started.jobId!;
    expect(await handlers.ocrDataState()).toMatchObject({
      consent: true,
      state: "missing",
    });
    await expect.poll(state(runner, id)).toBe("failed");
    expect(job(runner, id)).toMatchObject({
      error: "ocr-data-offline",
      stepLabel: "sources.jobs.ocrData",
    });
    expect(job(runner, id)?.steps.map((step) => step.name)).toEqual([
      "eng",
      "ita",
    ]);
    expect(
      existsSync(ocrDataDir(tess)) ? readdirSync(ocrDataDir(tess)) : [],
    ).toEqual([]);
    fetchSpy.mockImplementation(
      (async () =>
        new Response(Buffer.alloc(OCR_DATA_FILES.eng!.size))) as never,
    );
    runner.retry(id);
    await expect.poll(state(runner, id)).toBe("failed");
    expect(job(runner, id)?.error).toBe("ocr-data-integrity");
  });

  it.skipIf(!haveData)(
    "finishes with the real pinned files, then reads photos and reports ready",
    async () => {
      const { handlers, runner, fetchSpy, tess, db } = setup();
      const urls: string[] = [];
      fetchSpy.mockImplementation((async (url: string) => {
        urls.push(url);
        return new Response(
          readFileSync(join(pinned, url.slice(url.lastIndexOf("/") + 1))),
        );
      }) as never);
      const { jobId } = await handlers.ocrData({ consent: true });
      // The list hides finished jobs, so the stored row is what shows it succeeded.
      await expect
        .poll(
          () =>
            (
              db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(jobId) as {
                state: string;
              }
            ).state,
          { timeout: 20_000 },
        )
        .toBe("succeeded");
      expect(urls).toEqual([
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata",
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/ita.traineddata",
      ]);
      expect(await handlers.ocrDataState()).toMatchObject({
        consent: true,
        state: "ready",
      });
      expect(readdirSync(ocrDataDir(tess)).sort()).toEqual([
        "eng.traineddata",
        "ita.traineddata",
      ]);
      // Agreeing when everything is already there starts nothing.
      expect(await handlers.ocrData({ consent: true })).toEqual({
        state: "ready",
      });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({
        n: 1,
      });
    },
    30_000,
  );

  it("cancel stops the download, leaves no file, and a second agreement re-attaches to the running job", async () => {
    const { handlers, runner, fetchSpy, tess } = setup();
    fetchSpy.mockImplementation(
      (async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new Uint8Array(10));
              init.signal?.addEventListener("abort", () =>
                stream.error(init.signal?.reason),
              );
            },
          }),
        )) as never,
    );
    const { jobId } = await handlers.ocrData({ consent: true });
    await expect.poll(() => fetchSpy.mock.calls.length).toBeGreaterThan(0);
    // Agreeing again while it runs re-attaches to the same job instead of starting a second download, and the state names it.
    expect((await handlers.ocrData({ consent: true })).jobId).toBe(jobId);
    expect(await handlers.ocrDataState()).toMatchObject({
      consent: true,
      state: "missing",
      jobId,
    });
    runner.cancel(jobId!);
    await expect.poll(state(runner, jobId!)).toBe("cancelled");
    expect(
      existsSync(ocrDataDir(tess)) ? readdirSync(ocrDataDir(tess)) : [],
    ).toEqual([]);
  });

  it("withdrawing consent cancels the running download, publishes nothing, and a retry without consent refuses", async () => {
    const { handlers, runner, fetchSpy, tess } = setup();
    let aborted = false;
    fetchSpy.mockImplementation(
      (async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new Uint8Array(10));
              init.signal?.addEventListener("abort", () => {
                aborted = true;
                stream.error(init.signal?.reason);
              });
            },
          }),
        )) as never,
    );
    const { jobId } = await handlers.ocrData({ consent: true });
    await expect.poll(() => fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(await handlers.ocrData({ consent: false })).toEqual({ state: "off" });
    await expect.poll(state(runner, jobId!)).toBe("cancelled");
    expect(aborted).toBe(true);
    // The saved answer is off, no job is running any more, and nothing was kept.
    expect(await handlers.ocrDataState()).toEqual({
      consent: false,
      state: "missing",
      totalBytes,
      languages: ["eng", "ita"],
    });
    expect(existsSync(ocrDataDir(tess)) ? readdirSync(ocrDataDir(tess)) : []).toEqual([]);
    // Retrying the cancelled job without consent stops at the first step and fetches nothing more.
    const fetched = fetchSpy.mock.calls.length;
    runner.retry(jobId!);
    await expect.poll(state(runner, jobId!)).toBe("failed");
    expect(job(runner, jobId!)?.error).toBe("ocr-data-declined");
    expect(fetchSpy.mock.calls.length).toBe(fetched);
  });

  it("withdrawing consent while no download runs only saves the answer", async () => {
    const { handlers, runner } = setup();
    expect(await handlers.ocrData({ consent: false })).toEqual({ state: "off" });
    expect(runner.list()).toEqual([]);
  });
});
