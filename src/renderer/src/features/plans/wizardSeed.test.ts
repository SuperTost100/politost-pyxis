import { describe, expect, it } from "vitest";
import { examChosen, examFromChoice, isWizardSeed } from "./wizardSeed";

describe("exam from the wizard", () => {
  const now = new Date(2026, 9, 4, 9);

  it("stores noon on the day, and no date for no date yet", () => {
    expect(examFromChoice("", "2026-12-15", now)).toBe(new Date(2026, 11, 15, 12).getTime());
    expect(examFromChoice("3", "", now)).toBe(new Date(2026, 9, 7, 12).getTime());
    expect(examFromChoice("none", "", now)).toBeNull();
    expect(examFromChoice("", "", now)).toBeNull();
  });

  it("waits for an answer: nothing chosen is not the same as no date yet", () => {
    expect(examChosen("", "")).toBe(false);
    expect(examChosen("none", "")).toBe(true);
    expect(examChosen("", "2026-12-15")).toBe(true);
    expect(examChosen("10", "")).toBe(true);
  });

  it("accepts a seed with no date yet", () => {
    const seed = { title: "T", subject: "", date: "", target: 75, language: "it" };
    expect(isWizardSeed({ ...seed, examChoice: "none" })).toBe(true);
    expect(isWizardSeed({ ...seed, examChoice: "" })).toBe(true);
    expect(isWizardSeed({ ...seed, examChoice: "7" })).toBe(false);
  });
});
