import { afterEach, describe, expect, it, vi } from "vitest";
import { staleBatcher, staleFamilies, type StaleFamily } from "./jobInvalidation";

const keys = (families: StaleFamily[]) =>
  families.map(({ key, refetch }) => (refetch ? key : `${key}:later`));

describe("job update invalidation", () => {
  it("refreshes plans only when a job ends", () => {
    expect(keys(staleFamilies({ kind: "plan-build", state: "running" }))).toEqual(["jobs", "plan-build"]);
    expect(keys(staleFamilies({ kind: "plan-build", state: "succeeded" }))).toEqual([
      "jobs",
      "plan-build",
      "jobs-finished",
      "plans",
      "plan",
      "source-details",
      "series:later",
    ]);
    expect(keys(staleFamilies({ kind: "quiz-build", state: "running" }))).toEqual(["jobs"]);
    expect(keys(staleFamilies({ kind: "cards-build", state: "failed" }))).toEqual([
      "jobs",
      "jobs-finished",
      "plans",
      "plan",
      "series:later",
    ]);
  });

  it("refreshes a source's citation counts when a job that cites passages ends", () => {
    for (const kind of ["plan-build", "plan-rebuild", "quiz-build", "quiz-replace", "gap-drill"])
      expect(keys(staleFamilies({ kind, state: "succeeded" }))).toContain("source-details");
    expect(keys(staleFamilies({ kind: "quiz-build", state: "running" }))).not.toContain("source-details");
    expect(keys(staleFamilies({ kind: "cards-build", state: "succeeded" }))).not.toContain("source-details");
  });

  it("refreshes sources for imports and each download its own state", () => {
    expect(keys(staleFamilies({ kind: "source-import", state: "running" }))).toEqual([
      "jobs",
      "sources",
      "source-chapters",
      "source-meta",
      "source-details",
    ]);
    expect(keys(staleFamilies({ kind: "ocr-data-download", state: "queued" }))).toEqual(["jobs", "ocr-data"]);
    expect(keys(staleFamilies({ kind: "embedding-download", state: "running" }))).toEqual(["jobs", "embedding"]);
  });
});

describe("stale batcher", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes a burst once, after updates pause", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batch = staleBatcher(flush);
    batch.add(staleFamilies({ kind: "source-import", state: "running" }));
    vi.advanceTimersByTime(200);
    batch.add(staleFamilies({ kind: "plan-build", state: "succeeded" }));
    vi.advanceTimersByTime(200);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(keys(flush.mock.calls[0]![0] as StaleFamily[])).toEqual([
      "jobs",
      "sources",
      "source-chapters",
      "source-meta",
      "source-details",
      "plan-build",
      "jobs-finished",
      "plans",
      "plan",
      "series:later",
    ]);
  });

  it("still flushes during a steady stream of updates", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batch = staleBatcher(flush);
    for (let i = 0; i < 10; i++) {
      batch.add([{ key: "jobs", refetch: true }]);
      vi.advanceTimersByTime(150);
    }
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("refetches a family when any update in the batch asks for it", () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const batch = staleBatcher(flush);
    batch.add([{ key: "series", refetch: true }]);
    batch.add([{ key: "series", refetch: false }]);
    vi.advanceTimersByTime(250);
    expect(flush).toHaveBeenCalledWith([{ key: "series", refetch: true }]);
    batch.add([{ key: "jobs", refetch: true }]);
    batch.cancel();
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
