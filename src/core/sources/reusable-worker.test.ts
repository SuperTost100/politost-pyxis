import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { ReusableWorker } from "./reusable-worker";

// A stand-in for the embedding worker: loads once ("model"), answers requests, exits on close.
const SCRIPT = `
const { parentPort, threadId } = require("node:worker_threads");
let loads = 0;
parentPort.on("message", async (m) => {
  if (m.close) process.exit(0);
  const { id, request } = m;
  if (request === "crash") process.exit(3);
  if (request === "fail") return parentPort.postMessage({ id, error: "boom" });
  if (request === "slow") return;
  loads += 1;
  parentPort.postMessage({ id, value: { thread: threadId, loads, request } });
});
`;

const dirs: string[] = [];
const workers: ReusableWorker<unknown, unknown>[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(idleMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-reusable-"));
  dirs.push(dir);
  const file = join(dir, "worker.cjs");
  writeFileSync(file, SCRIPT);
  let spawned = 0;
  const pool = new ReusableWorker<unknown, { thread: number; loads: number; request: unknown }>(
    () => {
      spawned += 1;
      return new Worker(file);
    },
    idleMs,
    200,
  );
  workers.push(pool as ReusableWorker<unknown, unknown>);
  return { pool, spawned: () => spawned };
}

describe("a worker kept alive between calls", () => {
  it("serves several calls from one worker and reports busy while one is running", async () => {
    const { pool, spawned } = setup();
    const first = await pool.run("a");
    const second = await pool.run("b");
    expect(spawned()).toBe(1);
    expect(second.thread).toBe(first.thread);
    expect(second.loads).toBe(2);
    const slow = pool.run("slow");
    const closed = expect(slow).rejects.toThrow("source-worker-exited");
    expect(pool.busy).toBe(true);
    expect(() => pool.run("c")).toThrow("worker-busy");
    pool.close();
    await closed;
    expect(pool.busy).toBe(false);
  });

  it("terminates on cancel, and the next call gets a fresh worker", async () => {
    const { pool, spawned } = setup();
    const controller = new AbortController();
    const first = pool.run("slow", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelled;
    await expect(pool.run("again")).resolves.toMatchObject({ loads: 1 });
    expect(spawned()).toBe(2);
    await expect(pool.run("x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
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

  it("lets the worker go after the idle time", async () => {
    const { pool, spawned } = setup(40);
    await pool.run("a");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(pool.run("b")).resolves.toMatchObject({ loads: 1 });
    expect(spawned()).toBe(2);
  });
});
