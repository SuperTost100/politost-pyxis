import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestEvery } from "./throttle";

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
