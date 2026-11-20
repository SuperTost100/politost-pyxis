import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreRetry } from "./core-retry";
import { coreExited, stopCoreProcess, watchCoreExit } from "./core-stop";

/** A core that exits `killedAfter` ms after it is killed, and ignores a shutdown request. */
function core(killedAfter: number) {
  const child = Object.assign(new EventEmitter(), {
    postMessage() {},
    kill() {
      setTimeout(() => child.emit("exit", null), killedAfter);
      return true;
    },
  });
  watchCoreExit(child);
  return child;
}

/** What startup does with a core it gives up on: ends it at once and shows the notice. */
function giveUp(child: ReturnType<typeof core>) {
  void stopCoreProcess(child, 0).catch(() => undefined);
}

function setup(child: ReturnType<typeof core> | null) {
  const state = { child, blocked: false, starts: 0 };
  const retry = createCoreRetry({
    blocked: () => state.blocked,
    current: () => state.child,
    start: async () => {
      state.starts += 1;
      state.child = core(0);
    },
  });
  return { state, retry };
}

describe("the Retry button", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a new core once the old one, still on its way out when Retry was pressed, has exited", async () => {
    const old = core(2_000);
    const { state, retry } = setup(old);
    giveUp(old);
    await vi.advanceTimersByTimeAsync(0);
    const pressed = retry();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(state.starts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await pressed;
    expect(state.starts).toBe(1);
  });

  it("starts one core when Retry is pressed twice while the old one is leaving", async () => {
    const old = core(500);
    const { state, retry } = setup(old);
    giveUp(old);
    await vi.advanceTimersByTimeAsync(0);
    const pressed = [retry(), retry()];
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(pressed);
    expect(state.starts).toBe(1);
  });

  it("starts a new core at once when the old one has already exited", async () => {
    const old = core(0);
    const { state, retry } = setup(old);
    giveUp(old);
    await vi.advanceTimersByTimeAsync(1);
    expect(coreExited(old)).toBe(true);
    await retry();
    expect(state.starts).toBe(1);
  });

  it("does nothing while a core is running and nobody is stopping it", async () => {
    const { state, retry } = setup(core(0));
    await retry();
    expect(state.starts).toBe(0);
  });

  it("does nothing while a backup, restore, move or wipe holds core, also when that starts during the wait", async () => {
    const old = core(1_000);
    const { state, retry } = setup(old);
    state.blocked = true;
    await retry();
    expect(state.starts).toBe(0);
    state.blocked = false;
    giveUp(old);
    await vi.advanceTimersByTimeAsync(0);
    const pressed = retry();
    state.blocked = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await pressed;
    expect(state.starts).toBe(0);
  });

  it("starts nothing when the old core cannot be stopped at all", async () => {
    const old = Object.assign(new EventEmitter(), {
      postMessage() {},
      kill: () => true,
    });
    watchCoreExit(old);
    const { state, retry } = setup(old);
    giveUp(old);
    await vi.advanceTimersByTimeAsync(0);
    const pressed = retry();
    await vi.advanceTimersByTimeAsync(20_000);
    await pressed;
    expect(state.starts).toBe(0);
  });
});
