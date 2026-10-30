import { describe, expect, it } from "vitest";
import {
  defaultGoal,
  defaultGradeScale,
  formatGrade,
  formatGradeDelta,
  formatGradeWhole,
  goalFraction,
  goalInput,
  goalRange,
  gradeScaleOf,
  gradeValue,
  gradeWhole,
  scaledMastery,
} from "./grade";

describe("scaledMastery", () => {
  it("keeps the exact position on the scale, so a chart point is never drawn under a goal it has passed", () => {
    // 22.8 out of 30 is above a goal of 22.5; flooring it to 22 would draw it below.
    expect(scaledMastery(0.76, 30)).toBeCloseTo(22.8, 9);
    expect(scaledMastery(0.76, 30)).toBeGreaterThan(gradeValue(0.75, 30));
    expect(scaledMastery(0.759, 100)).toBeCloseTo(75.9, 9);
    expect(scaledMastery(1.2, 30)).toBe(30);
    expect(scaledMastery(-0.1, 100)).toBe(0);
  });
});

describe("grade scale", () => {
  it("defaults to 30 at university and 100 at every other level, and a picked scale wins", () => {
    expect(defaultGradeScale("university")).toBe(30);
    expect(defaultGradeScale("upper-secondary")).toBe(100);
    expect(defaultGradeScale("other")).toBe(100);
    expect(gradeScaleOf(null)).toBe(30);
    expect(gradeScaleOf({ educationLevel: "primary", gradeScale: null })).toBe(100);
    expect(gradeScaleOf({ educationLevel: "university", gradeScale: 100 })).toBe(100);
    expect(gradeScaleOf({ educationLevel: "technical", gradeScale: 30 })).toBe(30);
  });

  it("rounds down to one decimal out of 30 and to whole numbers out of 100", () => {
    expect(gradeValue(0.75, 30)).toBe(22.5);
    expect(gradeValue(0.523, 30)).toBe(15.6);
    expect(gradeValue(0.523, 100)).toBe(52);
    expect(gradeValue(0.759, 100)).toBe(75);
    expect(gradeValue(0.995, 100)).toBe(99);
    // 0.57 × 30 is 17.0999… in floating point.
    expect(gradeValue(0.57, 30)).toBe(17.1);
    // Out of range fractions stay on the scale.
    expect(gradeValue(1.2, 30)).toBe(30);
    expect(gradeValue(-0.1, 100)).toBe(0);
  });

  it("shows 18/30 only from the pass mark up", () => {
    expect(formatGrade(0.6, 30, "it")).toBe("18/30");
    expect(formatGrade(18 / 30, 30, "it")).toBe("18/30");
    expect(formatGrade(0.5999, 30, "it")).toBe("17,9/30");
    expect(formatGrade(0.59, 30, "it")).toBe("17,7/30");
  });

  it("reads a full mark as 30/30 and 100/100", () => {
    expect(formatGrade(1, 30, "it")).toBe("30/30");
    expect(formatGrade(29 / 30 + 1 / 30, 30, "en")).toBe("30/30");
    expect(formatGrade(1, 100, "it")).toBe("100/100");
  });

  it("writes the decimal mark of the language", () => {
    expect(formatGrade(0.75, 30, "it")).toBe("22,5/30");
    expect(formatGrade(0.75, 30, "en")).toBe("22.5/30");
    expect(formatGrade(0.75, 100, "it")).toBe("75/100");
    expect(formatGradeDelta(0.05, 30, "it")).toBe("+1,5");
    expect(formatGradeDelta(-0.1, 100, "en")).toBe("-10");
    expect(formatGradeDelta(0.001, 30, "it")).toBe("0");
  });

  it("takes a goal from 18 to 30 out of 30, and keeps stored goals inside 0.5 to 1", () => {
    expect(goalRange(30)).toMatchObject({ min: 18, max: 30, step: 1 });
    expect(goalRange(100)).toMatchObject({ min: 50, max: 100, step: 5 });
    expect(goalFraction(18, 30)).toBeCloseTo(0.6);
    expect(goalFraction(30, 30)).toBe(1);
    expect(goalFraction(12, 30)).toBeCloseTo(0.6);
    expect(goalFraction(31, 30)).toBe(1);
    expect(goalFraction(75, 100)).toBe(0.75);
    // A goal saved out of 100 below the pass mark opens at 18 out of 30.
    expect(goalInput(0.5, 30)).toBe(18);
    expect(goalInput(goalFraction(26, 30), 30)).toBe(26);
    expect(goalInput(0.75, 100)).toBe(75);
    expect(defaultGoal(100)).toBe(75);
    expect(defaultGoal(30)).toBe(23);
  });

  it("rounds mastery down to a whole number so a topic never looks at the goal before it is", () => {
    expect(gradeWhole(18.6 / 30, 30)).toBe(18);
    expect(gradeWhole(29.99 / 30, 30)).toBe(29);
    expect(gradeWhole(1, 30)).toBe(30);
    expect(gradeWhole(0, 30)).toBe(0);
    // 0.57 × 30 is 17.0999… in floating point, and the pass mark itself stays 18.
    expect(gradeWhole(0.57, 30)).toBe(17);
    expect(gradeWhole(0.6, 30)).toBe(18);
    expect(gradeWhole(0.599, 30)).toBe(17);
    expect(gradeWhole(0.759, 100)).toBe(75);
    expect(gradeWhole(0.2999, 100)).toBe(29);
    expect(gradeWhole(1, 100)).toBe(100);
    expect(gradeWhole(1.2, 30)).toBe(30);
    expect(gradeWhole(-0.1, 100)).toBe(0);
  });

  it("writes a whole mastery with the scale", () => {
    expect(formatGradeWhole(18.6 / 30, 30)).toBe("18/30");
    expect(formatGradeWhole(0.759, 100)).toBe("75/100");
    expect(formatGradeWhole(1, 30)).toBe("30/30");
  });
});
