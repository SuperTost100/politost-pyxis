import { describe, expect, it } from "vitest";
import { emptyDraft } from "./examSessions";
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
    expect(examChosen("", [emptyDraft()])).toBe(false);
    expect(examChosen("none", [emptyDraft()])).toBe(true);
    expect(examChosen("", [emptyDraft({ date: "2026-12-15" })])).toBe(true);
    expect(examChosen("10", [emptyDraft({ date: "2026-10-14" })])).toBe(true);
    // A time or a place without a day is not an answer.
    expect(examChosen("", [emptyDraft({ time: "09:00", place: "Aula" })])).toBe(false);
  });

  it("accepts a seed with no date yet", () => {
    const seed = { title: "T", subject: "", sessions: [emptyDraft()], target: 75, language: "it" };
    expect(isWizardSeed({ ...seed, examChoice: "none" })).toBe(true);
    expect(isWizardSeed({ ...seed, examChoice: "" })).toBe(true);
    expect(isWizardSeed({ ...seed, examChoice: "7" })).toBe(false);
  });
});
