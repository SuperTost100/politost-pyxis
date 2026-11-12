import { describe, expect, it } from "vitest";
import { chipState, newChipState, settleNewSubject, subjectToSend } from "./scope";

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

  it("shows an older chat's hand-picked sources, leaving its attachments out", () => {
    expect(chipState({ ...chat, sourceIds: ["a", "b", "att"], held: [{ id: "att" }] })).toEqual({ kind: "picked", count: 2 });
    expect(chipState({ ...chat, sourceIds: ["att"], held: [{ id: "att" }] })).toEqual({ kind: "auto" });
    // A chat opened from an exam knows its subject, which the chip shows.
    expect(chipState({ ...chat, subject: "Analisi 1", planId: "p" })).toMatchObject({ kind: "subject" });
  });

  it("names the exam when the chat is opened from one with no subject and no sources picked by hand", () => {
    expect(chipState({ ...chat, planId: "p", planTitle: "Analisi 1, luglio" })).toEqual({
      kind: "exam",
      title: "Analisi 1, luglio",
      extra: 0,
    });
    // Before the exam is read the chip still says it is one.
    expect(chipState({ ...chat, planId: "p" })).toEqual({ kind: "exam", title: null, extra: 0 });
    // Sources picked by hand beside the exam are counted apart, and the chat's attachments are not.
    expect(
      chipState({ ...chat, planId: "p", planTitle: "Analisi 1", sourceIds: ["a", "b", "att"], held: [{ id: "att" }] }),
    ).toEqual({ kind: "exam", title: "Analisi 1", extra: 2 });
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

describe("a new chat's pending choice against the Library's subjects", () => {
  const library = [
    { id: "s-fis", name: "Fisica generale" },
    { id: "s-an", name: "Analisi 1" },
  ];

  it("follows a subject that was renamed, by its id", () => {
    expect(settleNewSubject({ kind: "subject", id: "s-fis", name: "Fisica 2" }, library)).toEqual({
      kind: "subject",
      id: "s-fis",
      name: "Fisica generale",
    });
  });

  it("goes back to Pyxis's choice when the subject is gone, and leaves the other choices alone", () => {
    expect(settleNewSubject({ kind: "subject", id: "s-gone", name: "Chimica" }, library)).toEqual({ kind: "auto" });
    expect(settleNewSubject({ kind: "library" }, library)).toEqual({ kind: "library" });
    expect(settleNewSubject({ kind: "auto" }, library)).toEqual({ kind: "auto" });
  });

  it("finds a subject without an id by its name", () => {
    expect(settleNewSubject({ kind: "subject", name: "analisi 1" }, library)).toEqual({
      kind: "subject",
      id: "s-an",
      name: "Analisi 1",
    });
  });
});
