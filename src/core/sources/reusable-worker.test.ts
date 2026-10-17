import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { ReusableWorker } from "./reusable-worker";

// A stand-in for the embedding worker: counts the requests served since its "model" loaded, drops the model on unload,
// and answers a cancel for a slow request. A stuck request ignores the cancel.
const SCRIPT = `
const { parentPort, threadId } = require("node:worker_threads");
let loads = 0;
const slow = new Set();
parentPort.on("message", async (m) => {
  if (m.unload) return void (loads = 0);
  if (m.cancel) {
    if (slow.delete(m.cancel)) parentPort.postMessage({ id: m.cancel, error: "embed-cancelled" });
    return;
  }
  const { id, request } = m;
  if (request === "crash") process.exit(3);
  if (request === "fail") return parentPort.postMessage({ id, error: "boom" });
  if (request === "slow") return slow.add(id);
  if (request === "stuck") return;
  loads += 1;
  parentPort.postMessage({ id, value: { thread: threadId, loads, request } });
});
`;

const dirs: string[] = [];
const threads: Worker[] = [];
afterEach(async () => {
  await Promise.all(threads.splice(0).map((thread) => thread.terminate()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(idleMs = 60_000, cancelMs = 30_000) {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-reusable-"));
  dirs.push(dir);
  const file = join(dir, "worker.cjs");
  writeFileSync(file, SCRIPT);
  let spawned = 0;
  const pool = new ReusableWorker<unknown, { thread: number; loads: number; request: unknown }>(
    () => {
      spawned += 1;
      const thread = new Worker(file);
      threads.push(thread);
      return thread;
    },
    idleMs,
    cancelMs,
  );
  return { pool, spawned: () => spawned };
}

describe("a worker kept alive between calls", () => {
  it("serves several calls from one worker, in order, and reports busy while one is running or waiting", async () => {
    const { pool, spawned } = setup();
    const first = await pool.run("a");
    const second = await pool.run("b");
    expect(spawned()).toBe(1);
    expect(second.thread).toBe(first.thread);
    expect(second.loads).toBe(2);
    const slow = pool.run("slow");
    const unloaded = expect(slow).rejects.toThrow("source-worker-exited");
    expect(pool.busy).toBe(true);
    const waiting = expect(pool.run("c")).rejects.toThrow("source-worker-exited");
    pool.unload();
    await unloaded;
    await waiting;
    // The slow request is cancelled and the model released, but the thread stays.
    const [c, d] = await Promise.all([pool.run("c"), pool.run("d")]);
    expect([c.request, d.request]).toEqual(["c", "d"]);
    expect(c).toMatchObject({ thread: first.thread, loads: 1 });
    expect(spawned()).toBe(1);
    expect(pool.busy).toBe(false);
  });

  it("puts an urgent call before the waiting ones, after the call already running", async () => {
    const { pool } = setup();
    await pool.run("warm");
    const order: unknown[] = [];
    const track = (request: string, urgent = false) =>
      pool.run(request, undefined, urgent).then((value) => order.push(value.request));
    await Promise.all([track("running"), track("queued 1"), track("queued 2"), track("urgent 1", true), track("urgent 2", true)]);
    expect(order).toEqual(["running", "urgent 1", "urgent 2", "queued 1", "queued 2"]);
  });

  it("cancels inside the worker instead of terminating it, and the next call waits for that answer", async () => {
    const { pool, spawned } = setup();
    const warm = await pool.run("warm");
    const controller = new AbortController();
    const first = pool.run("slow", controller.signal);
    const queued = new AbortController();
    const dropped = pool.run("never", queued.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    queued.abort();
    // The caller hears of the cancel at once; a waiting call leaves the queue without reaching the worker.
    await cancelled;
    await expect(dropped).rejects.toMatchObject({ name: "AbortError" });
    const after = await pool.run("again");
    expect(after).toMatchObject({ thread: warm.thread, loads: 2 });
    expect(spawned()).toBe(1);
    await expect(pool.run("x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spawned()).toBe(1);
  });

  it("terminates a worker that does not answer a cancel in time, and the next call gets a fresh one", async () => {
    const { pool, spawned } = setup(60_000, 50);
    const controller = new AbortController();
    const stuck = pool.run("stuck", controller.signal);
    const next = pool.run("next");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(stuck).rejects.toMatchObject({ name: "AbortError" });
    await expect(next).resolves.toMatchObject({ loads: 1, request: "next" });
    expect(spawned()).toBe(2);
  });

  it("recovers from a crash and keeps the worker after an error reply", async () => {
    const { pool, spawned } = setup();
    await pool.run("warm");
    await expect(pool.run("fail")).rejects.toThrow("boom");
    expect(spawned()).toBe(1);
    await expect(pool.run("crash")).rejects.toThrow("source-worker-exited");
    await expect(pool.run("after")).resolves.toMatchObject({ loads: 1 });
    expect(spawned()).toBe(2);
  });

  it("fails the waiting calls when no thread can be started, and the next call tries again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-reusable-"));
    dirs.push(dir);
    const file = join(dir, "worker.cjs");
    writeFileSync(file, SCRIPT);
    let attempts = 0;
    const pool = new ReusableWorker<unknown, { request: unknown }>(() => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
      const thread = new Worker(file);
      threads.push(thread);
      return thread;
    });
    const [first, second] = await Promise.allSettled([pool.run("a"), pool.run("b")]);
    expect(first).toMatchObject({ status: "rejected", reason: { message: "spawn EAGAIN" } });
    expect(second).toMatchObject({ status: "rejected", reason: { message: "spawn EAGAIN" } });
    expect(pool.busy).toBe(false);
    await expect(pool.run("c")).resolves.toMatchObject({ request: "c" });
    expect(attempts).toBe(2);
  });

  it("releases the model after the idle time and keeps the thread", async () => {
    const { pool, spawned } = setup(40);
    const first = await pool.run("a");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(pool.run("b")).resolves.toMatchObject({ thread: first.thread, loads: 1 });
    expect(spawned()).toBe(1);
  });
});
