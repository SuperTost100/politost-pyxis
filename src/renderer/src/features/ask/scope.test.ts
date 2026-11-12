import { describe, expect, it } from "vitest";
import { chipState, newChipState, subjectToSend } from "./scope";

const chat = {
  subject: null,
  subjectBy: null,
  planId: null,
  sourceIds: [] as string[],
  held: [] as Array<{ id: string }>,
};

describe("the chat's subject chip", () => {
  it("names the subject and who chose it", () => {
    expect(chipState({ ...chat, subject: "Fisica 2", subjectBy: "pyxis" })).toEqual({
      kind: "subject",
      name: "Fisica 2",
      by: "pyxis",
    });
    // A subject saved before Pyxis picked them was the student's.
    expect(chipState({ ...chat, subject: "Fisica 2" })).toMatchObject({ by: "student" });
  });

  it("says Pyxis will pick until a subject is set, and the whole Library once the student chose it", () => {
    expect(chipState(chat)).toEqual({ kind: "auto" });
    expect(chipState({ ...chat, subjectBy: "student" })).toEqual({ kind: "library" });
  });

  it("shows an older chat's hand-picked sources, counting an exam once and leaving its attachments out", () => {
    expect(
      chipState({ ...chat, planId: "p", sourceIds: ["a", "b", "att"], held: [{ id: "att" }] }),
    ).toEqual({ kind: "picked", count: 3 });
    expect(chipState({ ...chat, sourceIds: ["att"], held: [{ id: "att" }] })).toEqual({ kind: "auto" });
    // A chat opened from an exam knows its subject, which the chip shows.
    expect(chipState({ ...chat, subject: "Analisi 1", planId: "p" })).toMatchObject({ kind: "subject" });
  });

  it("sends a new chat's choice with its first question, and nothing when Pyxis picks", () => {
    expect(subjectToSend({ kind: "auto" })).toBeUndefined();
    expect(subjectToSend({ kind: "library" })).toBeNull();
    expect(subjectToSend({ kind: "subject", name: "Fisica 2" })).toBe("Fisica 2");
    expect(newChipState({ kind: "subject", name: "Fisica 2" })).toEqual({
      kind: "subject",
      name: "Fisica 2",
      by: "student",
    });
  });
});
