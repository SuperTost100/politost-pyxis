import { describe, expect, it } from "vitest";
import { usedLine } from "./usedLine";

const cite = (sourceId: string, subject: string | null, attached = false) => ({ sourceId, subject, attached });

describe("the line that says what an answer used", () => {
  it("names the one subject the cited files belong to", () => {
    expect(
      usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Fisica 2"), cite("a", "Fisica 2")] }),
    ).toEqual({ key: "ask.used.subject", values: { count: 3, subject: "Fisica 2" } });
  });

  it("names two subjects, and says 'your Library' for more or for files without a subject", () => {
    expect(usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Analisi 1")] })).toEqual({
      key: "ask.used.two",
      values: { count: 2, first: "Fisica 2", second: "Analisi 1" },
    });
    expect(
      usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", "Analisi 1"), cite("c", "Chimica")] }),
    ).toEqual({ key: "ask.used.library", values: { count: 3 } });
    expect(usedLine({ grounding: "sources", citations: [cite("a", "Fisica 2"), cite("b", null)] })).toEqual({
      key: "ask.used.library",
      values: { count: 2 },
    });
  });

  it("says the chat's subject had nothing when the answer looked wider", () => {
    expect(usedLine({ grounding: "wider", citations: [cite("a", "Analisi 1"), cite("b", "Analisi 1")] })).toEqual({
      key: "ask.used.subject",
      values: { count: 2, subject: "Analisi 1", context: "wider" },
    });
  });

  it("names the attached file when the answer used only that, by files", () => {
    expect(usedLine({ grounding: "sources", citations: [cite("att", null, true), cite("att", null, true)] })).toEqual({
      key: "ask.used.attached",
      values: { count: 1 },
    });
    // An attachment beside the Library is part of what the student brought.
    expect(usedLine({ grounding: "sources", citations: [cite("att", null, true), cite("a", "Fisica 2")] })).toEqual({
      key: "ask.used.library",
      values: { count: 2 },
    });
  });

  it("says plainly when the answer comes from general knowledge, and says nothing when nothing was searched", () => {
    expect(usedLine({ grounding: "general", citations: [] })).toEqual({ key: "ask.used.general", values: {} });
    expect(usedLine({ grounding: null, citations: [] })).toBeNull();
    // An attached file with no citation makes no claim either.
    expect(usedLine({ grounding: "sources", citations: [] })).toBeNull();
  });
});
