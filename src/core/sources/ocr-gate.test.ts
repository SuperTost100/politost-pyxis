import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// A stand-in for the worker thread: it answers after a short wait and counts how many are alive at once.
const pool = vi.hoisted(() => ({ live: 0, peak: 0, spawned: [] as unknown[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    constructor(_file: string, options: { workerData: { scratch?: string; hang?: boolean } }) {
      super();
      pool.spawned.push(options.workerData);
      // What the real worker does: it keeps this run's language files in the scratch folder it was given.
      try {
        if (options.workerData.scratch) {
          mkdirSync(options.workerData.scratch, { recursive: true });
          writeFileSync(join(options.workerData.scratch, "eng.traineddata"), "x");
        }
      } catch {
        // The other tests give a made-up folder that cannot be created, and look at no files.
      }
      if (options.workerData.hang) return;
      pool.live += 1;
      pool.peak = Math.max(pool.peak, pool.live);
      setTimeout(() => this.emit("message", { value: "texto" }), 10);
    }
    terminate() {
      pool.live -= 1;
      return Promise.resolve(0);
    }
    unref() {}
  }
  return { Worker: FakeWorker, parentPort: null, workerData: null };
});
const { ocrBytes, runSourceWorker } = await import("./worker-client");

it("SRC-04 local OCR runs in the extract worker, two at a time, and hands it the bytes instead of decoding on core", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const all = await Promise.all(Array.from({ length: 6 }, () => ocrBytes(bytes, "/cache")));
  expect(all).toEqual(Array(6).fill("texto"));
  expect(pool.peak).toBe(2);
  expect(pool.live).toBe(0);
  expect(pool.spawned[0]).toMatchObject({ mode: "ocr", tess: "/cache", bytes });
});

it("cancels a queued OCR call without spawning a worker for it", async () => {
  pool.spawned.length = 0;
  const controller = new AbortController();
  const running = [ocrBytes(new Uint8Array(1), "/c"), ocrBytes(new Uint8Array(1), "/c")];
  const queued = ocrBytes(new Uint8Array(1), "/c", controller.signal);
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  await Promise.all(running);
  expect(pool.spawned).toHaveLength(2);
  expect(pool.live).toBe(0);
});

it("names a scratch folder under the workspace for each OCR run and removes it when the run is cancelled, so a terminated worker leaves nothing", async () => {
  pool.spawned.length = 0;
  const tess = mkdtempSync(join(tmpdir(), "pyxis-scratch-"));
  try {
    const controller = new AbortController();
    const pending = runSourceWorker("extract-worker", { path: "", ext: "", tess, mode: "ocr", bytes: new Uint8Array(1), hang: true }, controller.signal);
    await vi.waitFor(() => expect(pool.spawned).toHaveLength(1));
    const { scratch } = pool.spawned[0] as { scratch: string };
    expect(scratch.startsWith(join(tess, "scratch"))).toBe(true);
    expect(existsSync(scratch)).toBe(true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(existsSync(scratch)).toBe(false));
    // A finished run is cleaned the same way, and a call with no OCR data folder gets no scratch at all.
    await runSourceWorker("extract-worker", { path: "", ext: "", tess, mode: "ocr", bytes: new Uint8Array(1) });
    const { scratch: done } = pool.spawned[1] as { scratch: string };
    await vi.waitFor(() => expect(existsSync(done)).toBe(false));
    await runSourceWorker("extract-worker", { path: "", ext: ".txt", tess: "", mode: "extract", bytes: new Uint8Array(1) });
    expect(pool.spawned[2]).not.toHaveProperty("scratch");
  } finally {
    rmSync(tess, { recursive: true, force: true });
  }
});
