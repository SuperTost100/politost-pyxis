import { describe, expect, it } from "vitest";
import { drillGap, statusWordKey, tally, type ResultMark } from "./resultsSummary";

const answer = (mark: ResultMark, value?: number) => ({ mark, ...(value === undefined ? {} : { value }) });

describe("tally", () => {
  it("counts right, half right and wrong, leaving out what is zero and what is not scored", () => {
    expect(
      tally([
        answer("correct", 1),
        answer("wrong", 0),
        answer("correct", 1),
        answer("partial", 0.5),
        answer("flagged"),
        answer("wrong", 0),
        answer("correct", 1),
      ]),
    ).toEqual([
      { key: "right", count: 3 },
      { key: "half", count: 1 },
      { key: "wrong", count: 2 },
    ]);
    expect(tally([answer("correct", 1)])).toEqual([{ key: "right", count: 1 }]);
    // Answers still waiting for their grade are not counted yet.
    expect(tally([answer("grading"), answer("queued"), answer("ungraded")])).toEqual([]);
  });

  it("calls only an answer worth exactly half 'half right', and any other partial credit 'partly right'", () => {
    expect(tally([answer("partial", 0.9)])).toEqual([{ key: "partly", count: 1 }]);
    expect(tally([answer("partial", 0.25)])).toEqual([{ key: "partly", count: 1 }]);
    expect(tally([answer("partial", 0.5)])).toEqual([{ key: "half", count: 1 }]);
    // Both are said when both occur, the half ones first, and each has its own count.
    expect(
      tally([answer("partial", 0.9), answer("partial", 0.5), answer("partial", 0.25), answer("wrong", 0)]),
    ).toEqual([
      { key: "half", count: 1 },
      { key: "partly", count: 2 },
      { key: "wrong", count: 1 },
    ]);
  });

  it("takes a score that is half up to float noise as half", () => {
    expect(tally([answer("partial", 0.1 + 0.4)])).toEqual([{ key: "half", count: 1 }]);
  });
});

describe("statusWordKey", () => {
  it("names the word of each mark, 'half right' only at exactly half", () => {
    expect(statusWordKey({ mark: "partial", value: 0.5, answer: "x" })).toBe("results.half");
    expect(statusWordKey({ mark: "partial", value: 0.9, answer: "x" })).toBe("results.partly");
    expect(statusWordKey({ mark: "partial", value: 0.25, answer: "x" })).toBe("results.partly");
    expect(statusWordKey({ mark: "correct", value: 1, answer: "x" })).toBe("results.right");
    expect(statusWordKey({ mark: "wrong", value: 0, answer: "x" })).toBe("results.wrong");
    expect(statusWordKey({ mark: "wrong", value: 0, answer: "" })).toBe("results.dontKnow");
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
