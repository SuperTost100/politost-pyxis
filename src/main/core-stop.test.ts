import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORE_STOP_GRACE_MS,
  CORE_STOP_LIMIT_MS,
  coreExited,
  stopCoreProcess,
  watchCoreExit,
} from "./core-stop";

/** A core process that exits `exitAfter` ms after it is asked to shut down, or `killedAfter` ms after a kill. */
function core({
  exitAfter,
  killedAfter,
}: {
  exitAfter?: number;
  killedAfter?: number;
}) {
  const child = Object.assign(new EventEmitter(), {
    messages: [] as unknown[],
    kills: 0,
    postMessage(message: unknown) {
      child.messages.push(message);
      if (exitAfter !== undefined)
        setTimeout(() => child.emit("exit", 0), exitAfter);
    },
    kill() {
      child.kills += 1;
      if (killedAfter !== undefined)
        setTimeout(() => child.emit("exit", null), killedAfter);
      return true;
    },
  });
  return child;
}

/** Settles the stop as time passes, so a test can tell when it resolved or failed. */
function watch(stop: Promise<void>) {
  const state = { result: "pending" as "pending" | "stopped" | Error };
  stop.then(
    () => (state.result = "stopped"),
    (error: Error) => (state.result = error),
  );
  return state;
}

describe("stopCoreProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks core to shut down and waits for its own exit without killing it", async () => {
    const child = core({ exitAfter: 2_000 });
    const stop = watch(stopCoreProcess(child));
    expect(child.messages).toEqual([{ type: "shutdown" }]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stop.result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(stop.result).toBe("stopped");
    await vi.advanceTimersByTimeAsync(CORE_STOP_LIMIT_MS);
    expect(child.kills).toBe(0);
  });

  it("kills a core that does not exit in time and waits until the killed process is gone", async () => {
    // A slow Windows computer: the killed process takes 4 s to go, well past the old 3 s limit.
    const child = core({ killedAfter: 4_000 });
    const stop = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(CORE_STOP_GRACE_MS - 1);
    expect(child.kills).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toBe(1);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(stop.result).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(stop.result).toBe("stopped");
  });

  it("fails with core-busy when the process is still there at the limit", async () => {
    const child = core({});
    const stop = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(CORE_STOP_LIMIT_MS - 1);
    expect(stop.result).toBe("pending");
    expect(child.kills).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stop.result).toEqual(new Error("core-busy"));
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("leaves no timer or listener behind once core has stopped", async () => {
    const child = core({ exitAfter: 100 });
    const stop = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(100);
    expect(stop.result).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("returns at once for a core that has already exited", async () => {
    const child = core({});
    watchCoreExit(child);
    child.emit("exit", 0);
    expect(coreExited(child)).toBe(true);
    const stop = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(0);
    expect(stop.result).toBe("stopped");
    expect(child.messages).toEqual([]);
    expect(child.kills).toBe(0);
  });

  it("waits for a core whose start failed and is still being killed", async () => {
    // Startup gives up on a core (no ready or no keys in time) and kills it at once. Until the process has exited it
    // can still hold pyxis.db, so a backup, restore, move or wipe that follows must wait for that exit.
    const child = core({ killedAfter: 2_000 });
    watchCoreExit(child);
    const startup = watch(stopCoreProcess(child, 0));
    await vi.advanceTimersByTimeAsync(0);
    expect(child.kills).toBe(1);
    expect(coreExited(child)).toBe(false);
    const backup = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(1_999);
    expect([startup.result, backup.result]).toEqual(["pending", "pending"]);
    await vi.advanceTimersByTimeAsync(1);
    expect([startup.result, backup.result]).toEqual(["stopped", "stopped"]);
    expect(coreExited(child)).toBe(true);
    expect(child.kills).toBe(1);
  });

  it("lets two stops share one request, one kill and one exit", async () => {
    const child = core({ killedAfter: 500 });
    const first = watch(stopCoreProcess(child));
    const second = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(CORE_STOP_GRACE_MS + 499);
    expect([first.result, second.result]).toEqual(["pending", "pending"]);
    await vi.advanceTimersByTimeAsync(1);
    expect([first.result, second.result]).toEqual(["stopped", "stopped"]);
    expect(child.messages).toEqual([{ type: "shutdown" }]);
    expect(child.kills).toBe(1);
  });

  it("tries again after a stop that failed", async () => {
    const child = core({});
    const first = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(CORE_STOP_LIMIT_MS);
    expect(first.result).toEqual(new Error("core-busy"));
    const second = watch(stopCoreProcess(child));
    await vi.advanceTimersByTimeAsync(CORE_STOP_GRACE_MS);
    expect(child.kills).toBe(2);
    child.emit("exit", null);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.result).toBe("stopped");
  });
});
