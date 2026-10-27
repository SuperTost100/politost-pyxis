import { describe, expect, it } from "vitest";
import { automaticEffort, nearestEffort, taskEffort } from "./effort";

describe("task effort", () => {
  it("maps each task to its level", () => {
    expect(
      Object.fromEntries(
        ["chat", "map", "lesson", "vision", "default", "plan", "grading"].map(
          (feature) => [feature, taskEffort(feature)],
        ),
      ),
    ).toEqual({
      chat: "low",
      map: "low",
      lesson: "medium",
      vision: "medium",
      default: "medium",
      plan: "high",
      grading: "medium",
    });
  });

  it("uses the wanted level when the model lists it", () => {
    expect(nearestEffort("medium", ["low", "medium", "high"])).toBe("medium");
    expect(nearestEffort("high", ["low", "medium", "high", "xhigh"])).toBe(
      "high",
    );
  });

  it("looks lower first for low and medium, then higher", () => {
    expect(nearestEffort("medium", ["low", "high"])).toBe("low");
    expect(nearestEffort("low", ["medium", "high"])).toBe("medium");
    expect(nearestEffort("low", ["minimal", "medium"])).toBe("minimal");
    expect(nearestEffort("medium", ["high", "max"])).toBe("high");
  });

  it("looks higher first for high, then lower", () => {
    expect(nearestEffort("high", ["medium", "xhigh"])).toBe("xhigh");
    expect(nearestEffort("high", ["low", "medium"])).toBe("medium");
    expect(nearestEffort("high", ["low"])).toBe("low");
  });

  it("never picks none and ignores levels it does not know", () => {
    expect(nearestEffort("low", ["none", "medium"])).toBe("medium");
    expect(nearestEffort("low", ["none"])).toBeUndefined();
    expect(nearestEffort("medium", ["turbo"])).toBeUndefined();
    expect(nearestEffort("medium", [])).toBeUndefined();
  });

  it("combines the task and the model", () => {
    expect(automaticEffort("plan", ["low", "high"])).toBe("high");
    expect(automaticEffort("chat", ["medium"])).toBe("medium");
    expect(automaticEffort("lesson", [])).toBeUndefined();
  });
});
