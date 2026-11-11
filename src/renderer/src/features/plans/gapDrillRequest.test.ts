import { describe, expect, it } from "vitest";
import { readDrillRequest, stoppedTopic } from "./gapDrillRequest";

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
