import { describe, expect, it } from "vitest";
import { examFromChoice, isWizardSeed } from "./wizardSeed";

describe("exam from the wizard", () => {
  const now = new Date(2026, 9, 4, 9);

  it("stores noon on the day, noon on the 1st for a month, and nothing when nothing was chosen", () => {
    expect(examFromChoice("", "2026-12-15", now)).toEqual({
      examAt: new Date(2026, 11, 15, 12).getTime(),
      examMonth: false,
    });
    expect(examFromChoice("", "2027-01", now)).toEqual({
      examAt: new Date(2027, 0, 1, 12).getTime(),
      examMonth: true,
    });
    expect(examFromChoice("3", "", now)).toEqual({
      examAt: new Date(2026, 9, 7, 12).getTime(),
      examMonth: false,
    });
    expect(examFromChoice("", "", now)).toEqual({ examAt: null, examMonth: false });
  });

  it("accepts a seed with only a date or a month", () => {
    const seed = { title: "T", subject: "", date: "2027-01", target: 75, language: "it" };
    expect(isWizardSeed({ ...seed, examChoice: "" })).toBe(true);
    expect(isWizardSeed({ ...seed, examChoice: "7" })).toBe(false);
    expect(isWizardSeed({ ...seed, examChoice: undefined })).toBe(false);
  });
});
