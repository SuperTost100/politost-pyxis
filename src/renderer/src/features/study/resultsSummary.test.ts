import { describe, expect, it } from "vitest";
import { drillGap, tally } from "./resultsSummary";

describe("tally", () => {
  it("counts right, half right and wrong, leaving out what is zero and what is not scored", () => {
    expect(tally(["correct", "wrong", "correct", "partial", "flagged", "wrong", "correct"])).toEqual([
      { key: "right", count: 3 },
      { key: "partial", count: 1 },
      { key: "wrong", count: 2 },
    ]);
    expect(tally(["correct"])).toEqual([{ key: "right", count: 1 }]);
    // Answers still waiting for their grade are not counted yet.
    expect(tally(["grading", "queued", "ungraded"])).toEqual([]);
  });
});

describe("drillGap", () => {
  const gap = (topicId: string, severity: "severe" | "minor" | null, misconception: string | null, open = true) => ({
    topicId,
    severity,
    misconception,
    open,
  });
  it("picks an open gap, severe and explained first", () => {
    const gaps = [
      gap("kin", "minor", "Confonde spostamento e distanza"),
      gap("kin", "severe", null),
      gap("dyn", "severe", "Dimentica la forza peso"),
      gap("vec", "severe", "Somma i moduli", false),
    ];
    expect(drillGap(gaps)).toBe(gaps[2]);
    expect(drillGap(gaps.slice(0, 2))).toBe(gaps[1]);
    expect(drillGap(gaps.slice(0, 1))).toBe(gaps[0]);
  });
  it("finds nothing when every gap is closed", () => {
    expect(drillGap([gap("kin", "severe", "x", false)])).toBeUndefined();
    expect(drillGap([])).toBeUndefined();
  });
});
