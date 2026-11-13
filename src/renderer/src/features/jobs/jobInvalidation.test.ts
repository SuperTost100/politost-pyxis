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
      "card-sections",
      "source-details",
      "series:later",
    ]);
    expect(keys(staleFamilies({ kind: "quiz-build", state: "running" }))).toEqual(["jobs"]);
    expect(keys(staleFamilies({ kind: "cards-build", state: "failed" }))).toEqual([
      "jobs",
      "jobs-finished",
      "plans",
      "plan",
      "card-sections",
      "series:later",
    ]);
  });

  it("refreshes the Flashcard section when a job that makes flashcards ends, and not before", () => {
    for (const kind of ["cards-build", "cards-propose", "plan-build", "plan-rebuild"]) {
      expect(keys(staleFamilies({ kind, state: "succeeded" }))).toContain("card-sections");
      expect(keys(staleFamilies({ kind, state: "running" }))).not.toContain("card-sections");
    }
    expect(keys(staleFamilies({ kind: "quiz-build", state: "succeeded" }))).not.toContain("card-sections");
  });

  it("tells an open map page about its build from every update, and about its maps when the build ends", () => {
    // The page polls its build only while it runs, so a build resumed or retried elsewhere reaches it through this.
    expect(keys(staleFamilies({ kind: "map-build", state: "running" }))).toEqual(["jobs", "map-build"]);
    // A part of a lesson being written shows on the path's part rows; once written it changes the suggestion too.
    expect(keys(staleFamilies({ kind: "lesson-part", state: "running" }))).toEqual(["jobs", "parts"]);
    expect(keys(staleFamilies({ kind: "lesson-part", state: "succeeded" }))).toEqual([
      "jobs",
      "parts",
      "recommend",
      "jobs-finished",
      "plans",
      "plan",
      "series:later",
    ]);
    expect(keys(staleFamilies({ kind: "map-build", state: "succeeded" }))).toEqual([
      "jobs",
      "map-build",
      "maps",
      "map",
      "maps-all",
      "jobs-finished",
      "plans",
      "plan",
      "series:later",
    ]);
  });

  it("refreshes the attempt outcome when a gap-insight job ends, since it adds the misconception and severity to a gap", () => {
    expect(keys(staleFamilies({ kind: "gap-insight", state: "succeeded" }))).toContain("attempt-outcome");
    expect(keys(staleFamilies({ kind: "gap-insight", state: "failed" }))).toContain("attempt-outcome");
    expect(keys(staleFamilies({ kind: "gap-insight", state: "running" }))).not.toContain("attempt-outcome");
    expect(keys(staleFamilies({ kind: "quiz-build", state: "succeeded" }))).not.toContain("attempt-outcome");
  });

  it("refreshes a source's citation counts when a job that cites passages ends", () => {
    for (const kind of ["plan-build", "plan-rebuild", "quiz-build", "quiz-replace", "gap-drill"])
      expect(keys(staleFamilies({ kind, state: "succeeded" }))).toContain("source-details");
    expect(keys(staleFamilies({ kind: "quiz-build", state: "running" }))).not.toContain("source-details");
    expect(keys(staleFamilies({ kind: "cards-build", state: "succeeded" }))).not.toContain("source-details");
  });

  it("refreshes sources and subjects while the subjects of Library files are chosen", () => {
    expect(keys(staleFamilies({ kind: "library-sort", state: "running" }))).toEqual([
      "jobs",
      "sources",
      "source-chapters",
      "source-meta",
      "source-details",
      "subjects",
    ]);
  });

  it("refreshes the subjects when a source job ends, since its files decide whether a subject is in use", () => {
    for (const kind of ["source-import", "linked-folder-sort"]) {
      expect(keys(staleFamilies({ kind, state: "running" }))).not.toContain("subjects");
      expect(keys(staleFamilies({ kind, state: "succeeded" }))).toContain("subjects");
    }
    expect(keys(staleFamilies({ kind: "library-sort", state: "succeeded" })).filter((key) => key === "subjects")).toHaveLength(1);
  });

  it("refreshes the linked folders when a reading ends and while a look at a folder runs", () => {
    expect(keys(staleFamilies({ kind: "source-import", state: "running" }))).not.toContain("linked-folders");
    expect(keys(staleFamilies({ kind: "source-import", state: "succeeded" }))).toContain("linked-folders");
    expect(keys(staleFamilies({ kind: "linked-folder-read", state: "running" }))).toEqual(["jobs", "linked-folders"]);
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
      "card-sections",
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
