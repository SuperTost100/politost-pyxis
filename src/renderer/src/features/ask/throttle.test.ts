import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestEvery, liveValue } from "./throttle";

describe("latestEvery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the first value at once, then only the latest one per window", () => {
    const seen: string[] = [];
    const live = latestEvery<string>(100, (text) => seen.push(text));
    live.push("a");
    vi.advanceTimersByTime(0);
    expect(seen).toEqual(["a"]);
    live.push("ab");
    live.push("abc");
    live.push("abcd");
    vi.advanceTimersByTime(99);
    expect(seen).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["a", "abcd"]);
  });

  it("drops a pending value on cancel", () => {
    const seen: string[] = [];
    const live = latestEvery<string>(100, (text) => seen.push(text));
    live.push("a");
    vi.advanceTimersByTime(0);
    live.push("ab");
    live.cancel();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(["a"]);
  });
});

describe("liveValue", () => {
  it("tells subscribers about a new value once, and stops after unsubscribing", () => {
    const live = liveValue("");
    let calls = 0;
    const stop = live.subscribe(() => {
      calls += 1;
    });
    live.set("a");
    live.set("a");
    expect(live.get()).toBe("a");
    expect(calls).toBe(1);
    stop();
    live.set("ab");
    expect(live.get()).toBe("ab");
    expect(calls).toBe(1);
  });
});
