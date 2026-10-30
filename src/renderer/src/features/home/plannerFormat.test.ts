import { describe, expect, it } from "vitest";
import { formatGrade, formatGradeWhole } from "../../lib/grade";
import { behindText, decimalSeparator, formatHours } from "./plannerFormat";

describe("hours in the planner", () => {
  it("writes a half hour with the interface language's decimal mark", () => {
    expect(formatHours("it", 0.5)).toBe("0,5");
    expect(formatHours("it", 3.5)).toBe("3,5");
    expect(formatHours("en", 0.5)).toBe("0.5");
  });

  it("writes whole hours without a decimal", () => {
    expect(formatHours("it", 6)).toBe("6");
    expect(formatHours("en", 1234)).toBe("1,234");
  });

  it("tells the hours field which mark to show and accept", () => {
    expect(decimalSeparator("it")).toBe(",");
    expect(decimalSeparator("en")).toBe(".");
  });
});

describe("falling-behind warning", () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params)}`;
  const on30 = (fraction: number) => formatGrade(fraction, 30, "it");

  const whole30 = (fraction: number) => formatGradeWhole(fraction, 30);

  it("names the goal and the forecast on the profile's scale", () => {
    expect(
      behindText(t, { title: "Analisi", target: 0.8, behind: { daysLate: 3, masteryAtExam: 0.6 } }, on30, whole30),
    ).toBe('planner.behind:{"title":"Analisi","target":"24/30","count":3,"atExam":"18/30"}');
    expect(
      behindText(t, { title: "Analisi", target: 0.75, behind: { daysLate: null, masteryAtExam: 0 } }, on30, whole30),
    ).toBe('planner.behindNoTime:{"title":"Analisi","target":"22,5/30"}');
  });

  it("writes the forecast, a mastery, as a whole number", () => {
    expect(
      behindText(t, { title: "Analisi", target: 0.8, behind: { daysLate: 3, masteryAtExam: 0.77 } }, on30, whole30),
    ).toContain('"atExam":"23/30"');
  });
});
