import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// A stand-in worker whose stop the test controls: `terminate()` stays pending until `stop()` or `failStop()`.
const fake = vi.hoisted(() => ({
  workers: [] as Array<{ data: { scratch?: string }; emit(event: string, payload?: unknown): boolean; stop(): void; failStop(error: Error): void; terminated: number }>,
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWorker extends EventEmitter {
    terminated = 0;
    readonly data: { scratch?: string };
    private end!: { resolve(): void; reject(error: Error): void };
    private readonly ended = new Promise<void>((resolve, reject) => (this.end = { resolve, reject }));
    constructor(_file: string, options: { workerData: { scratch?: string } }) {
      super();
      this.data = options.workerData;
      fake.workers.push(this);
    }
    terminate() {
      this.terminated += 1;
      return this.ended;
    }
    stop() {
      this.end.resolve();
    }
    failStop(error: Error) {
      this.end.reject(error);
    }
    unref() {}
  }
  return { Worker: FakeWorker, parentPort: null, workerData: null };
});
const { Gate, runSourceWorker } = await import("./worker-client");
const at = (index: number) => {
  const worker = fake.workers[index];
  if (!worker) throw new Error(`worker ${index} was not spawned`);
  return worker;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("runs at most `limit` one-shot workers at once and queues the rest in order", async () => {
  const gate = new Gate(2);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const release: Array<() => void> = [];
  const work = (id: number) =>
    gate.hold(async () => {
      running += 1;
      peak = Math.max(peak, running);
      order.push(id);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
      return id;
    });
  const all = [1, 2, 3, 4, 5].map(work);
  await tick();
  expect(order).toEqual([1, 2]);
  while (release.length) {
    release.shift()!();
    await tick();
  }
  expect(await Promise.all(all)).toEqual([1, 2, 3, 4, 5]);
  expect(peak).toBe(2);
  expect(order).toEqual([1, 2, 3, 4, 5]);
});

it("lets a queued call be cancelled without starting it or blocking the others", async () => {
  const gate = new Gate(1);
  const started: string[] = [];
  let finish!: () => void;
  const first = gate.hold(async () => {
    started.push("first");
    await new Promise<void>((resolve) => (finish = resolve));
  });
  const controller = new AbortController();
  const cancelled = gate.hold(async () => void started.push("cancelled"), controller.signal);
  const last = gate.hold(async () => void started.push("last"));
  await tick();
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  finish();
  await Promise.all([first, last]);
  expect(started).toEqual(["first", "last"]);
  // A call that arrives already cancelled never waits.
  await expect(gate.hold(async () => 1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("frees its slot when the work fails", async () => {
  const gate = new Gate(1);
  await expect(gate.hold(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(await gate.hold(async () => "next")).toBe("next");
});

const decode = (signal?: AbortSignal) => runSourceWorker<string>("extract-worker", { mode: "pixels", path: "x", ext: ".jpg" }, signal);
/** Resolves `true` once the promise has settled, so a test can assert that it has not. */
const track = (promise: Promise<unknown>) => {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
};

it("returns a worker's answer, and frees the decode gate, only after the thread has really stopped", async () => {
  // Decode gate is 2 wide: fill it, so a third call can only start when a first one is truly done.
  const first = decode();
  const second = decode();
  const third = decode();
  const firstState = track(first);
  const thirdState = track(third);
  await tick();
  expect(fake.workers).toHaveLength(2);
  const a = at(0);
  a.emit("message", { value: "pixels" });
  await tick();
  // The worker has answered and terminate() was requested, but it has not exited: no result, no new worker.
  expect(a.terminated).toBe(1);
  expect(firstState.settled).toBe(false);
  expect(fake.workers).toHaveLength(2);
  expect(thirdState.settled).toBe(false);
  a.stop();
  expect(await first).toBe("pixels");
  await tick();
  expect(fake.workers).toHaveLength(3);
  at(1).emit("message", { value: "b" });
  at(1).stop();
  at(2).emit("message", { value: "c" });
  at(2).stop();
  expect(await Promise.all([second, third])).toEqual(["b", "c"]);
  fake.workers.length = 0;
});

it("keeps the first outcome when the caller cancels while the worker is still stopping, and still waits for the stop", async () => {
  const controller = new AbortController();
  const pending = decode(controller.signal);
  const state = track(pending);
  await tick();
  const worker = at(0);
  worker.emit("message", { error: "bad image" });
  controller.abort();
  await tick();
  expect(worker.terminated).toBe(1);
  expect(state.settled).toBe(false);
  worker.stop();
  await expect(pending).rejects.toThrow("bad image");
  fake.workers.length = 0;
});

it("cancels a running worker by terminating it and reports the cancel only once it has exited", async () => {
  const controller = new AbortController();
  const pending = decode(controller.signal);
  const state = track(pending);
  await tick();
  const worker = at(0);
  controller.abort();
  await tick();
  expect(worker.terminated).toBe(1);
  expect(state.settled).toBe(false);
  // The exit event racing the terminate promise changes nothing.
  worker.emit("exit", 1);
  worker.emit("message", { value: "late" });
  await tick();
  expect(state.settled).toBe(false);
  worker.stop();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminated).toBe(1);
  fake.workers.length = 0;
});

it("refuses even a good answer when the stop cannot be confirmed, and fails a crashed worker once it is gone", async () => {
  const answered = decode();
  await tick();
  const worker = at(0);
  worker.emit("message", { value: "pixels" });
  worker.failStop(new Error("no handle"));
  await expect(answered).rejects.toMatchObject({ message: "source-worker-stop-failed", cause: { message: "no handle" } });

  const crashed = decode();
  await tick();
  const dying = at(1);
  dying.emit("exit", 3221225477);
  await tick();
  dying.stop();
  await expect(crashed).rejects.toThrow("source-worker-exited");
  // The slots came back: a new call runs.
  const next = decode();
  await tick();
  expect(fake.workers).toHaveLength(3);
  at(2).emit("message", { value: "ok" });
  at(2).stop();
  expect(await next).toBe("ok");
  fake.workers.length = 0;
});

it("removes the OCR scratch folder only after the worker has stopped, and leaves it when the stop is unconfirmed", async () => {
  const tess = mkdtempSync(join(tmpdir(), "pyxis-stop-"));
  const run = () => runSourceWorker<string>("extract-worker", { path: "", ext: "", tess, mode: "ocr", bytes: new Uint8Array(1) });
  try {
    const stopped = run();
    await tick();
    const worker = at(0);
    mkdirSync(worker.data.scratch!, { recursive: true });
    worker.emit("message", { value: "texto" });
    await tick();
    expect(existsSync(worker.data.scratch!)).toBe(true);
    worker.stop();
    expect(await stopped).toBe("texto");
    expect(existsSync(worker.data.scratch!)).toBe(false);

    const unconfirmed = run();
    await tick();
    const lost = at(1);
    mkdirSync(lost.data.scratch!, { recursive: true });
    lost.emit("message", { value: "texto" });
    lost.failStop(new Error("no handle"));
    await expect(unconfirmed).rejects.toThrow("source-worker-stop-failed");
    expect(existsSync(lost.data.scratch!)).toBe(true);
  } finally {
    rmSync(tess, { recursive: true, force: true });
    fake.workers.length = 0;
  }
});
