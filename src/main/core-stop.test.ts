import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CORE_STOP_GRACE_MS,
  CORE_STOP_LIMIT_MS,
  stopCoreProcess,
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
});
