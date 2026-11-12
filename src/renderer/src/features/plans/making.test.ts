import { describe, expect, it } from "vitest";
import { madeFor, simulationSettled } from "./making";

const quiz = { kind: "quiz", planId: "a", attemptId: "x", topicId: "t", topicTitle: "T" } as const;

describe("an activity being made", () => {
  it("belongs to the exam it was made on, and shows on no other", () => {
    expect(madeFor(quiz, "a")).toBe(quiz);
    expect(madeFor(quiz, "b")).toBeNull();
    expect(madeFor(null, "a")).toBeNull();
  });
});

describe("a simulation build being waited for", () => {
  const old = { jobId: "old", state: "succeeded" };

  it("is not settled by an older build of the same exam left in the cache", () => {
    expect(simulationSettled("new", { data: old, isError: false, isFetchedAfterMount: false })).toBe(false);
    expect(simulationSettled("new", { data: null, isError: false, isFetchedAfterMount: false })).toBe(false);
  });

  it("is settled once its own job ends, and not while it runs", () => {
    const own = (state: string) => ({ data: { jobId: "new", state }, isError: false, isFetchedAfterMount: true });
    expect(simulationSettled("new", own("running"))).toBe(false);
    expect(simulationSettled("new", own("queued"))).toBe(false);
    for (const state of ["succeeded", "failed", "cancelled", "interrupted"])
      expect(simulationSettled("new", own(state))).toBe(true);
  });

  it("opens the page when a fresh read finds another job or none, or fails", () => {
    expect(simulationSettled("new", { data: old, isError: false, isFetchedAfterMount: true })).toBe(true);
    expect(simulationSettled("new", { data: null, isError: false, isFetchedAfterMount: true })).toBe(true);
    expect(simulationSettled("new", { data: undefined, isError: true, isFetchedAfterMount: false })).toBe(true);
  });
});
