import { describe, expect, it } from "vitest";
import { drillQuizPath, readDrillRequest, readGapStart, stoppedTopic } from "./gapDrillRequest";

describe("readDrillRequest", () => {
  it("starts a request once, even when it is read twice before the parameter is removed", () => {
    const first = readDrillRequest("t1", null);
    expect(first).toEqual({ started: "t1", begin: "t1" });
    expect(readDrillRequest("t1", first.started)).toEqual({
      started: "t1",
      begin: null,
    });
  });

  it("starts the same topic again once the parameter was removed in between", () => {
    const first = readDrillRequest("t1", null);
    const removed = readDrillRequest(null, first.started);
    expect(removed).toEqual({ started: null, begin: null });
    expect(readDrillRequest("t1", removed.started).begin).toBe("t1");
  });

  it("starts another topic at once", () => {
    expect(readDrillRequest("t2", "t1").begin).toBe("t2");
  });
});

describe("stoppedTopic", () => {
  it("keeps the topic of a drill that could not be started, so Retry has one to start", () => {
    expect(stoppedTopic("t1", false, null)).toBe("t1");
  });

  it("is the drill's topic when its job stopped, and nothing while it runs", () => {
    expect(stoppedTopic(null, true, "t2")).toBe("t2");
    expect(stoppedTopic(null, false, "t2")).toBeNull();
    expect(stoppedTopic(null, false, null)).toBeNull();
  });
});

describe("readGapStart", () => {
  it("waits until the exam's list has the gap", () => {
    expect(readGapStart(null, null)).toEqual({ started: null, begin: false });
  });

  it("starts the drill of a gap once, however often the page draws again", () => {
    const first = readGapStart("g1", null);
    expect(first).toEqual({ started: "g1", begin: true });
    expect(readGapStart("g1", first.started)).toEqual({ started: "g1", begin: false });
  });

  it("does not start again when the gap leaves a later read and comes back", () => {
    const first = readGapStart("g1", null);
    const away = readGapStart(null, first.started);
    expect(away).toEqual({ started: "g1", begin: false });
    expect(readGapStart("g1", away.started).begin).toBe(false);
  });

  it("starts the drill of another gap shown by the same page", () => {
    expect(readGapStart("g2", "g1")).toEqual({ started: "g2", begin: true });
  });
});

describe("drillQuizPath", () => {
  it("opens the path's drills as before, and names the gap when the page that asked knows it", () => {
    expect(drillQuizPath("p1", "t1", "a1")).toBe("/plans/p1/quiz/t1?attempt=a1");
    expect(drillQuizPath("p1", "t1", "a1", "g 1")).toBe("/plans/p1/quiz/t1?attempt=a1&gap=g%201");
  });
});
