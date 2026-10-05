import { expect, it } from "vitest";
import { Gate } from "./worker-client";

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
