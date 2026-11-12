import { describe, expect, it } from "vitest";
import { saveProposedInput, whatWouldBeLost, type ProposalTarget } from "./newCardLogic";

const idle = { step: "form", proposals: 0, front: "", back: "", newName: "", naming: false, focus: "" } as const;

describe("whatWouldBeLost", () => {
  it("is nothing for a dialog nobody wrote in", () => {
    expect(whatWouldBeLost(idle)).toBeNull();
    expect(whatWouldBeLost({ ...idle, front: "  ", focus: "\n" })).toBeNull();
  });

  it("asks about Pyxis's work and its proposals whichever side shows, because they are what the dialog holds", () => {
    // Nothing here mentions the side: the same state asks the same question from "Scrivila tu" and from Pyxis's side.
    expect(whatWouldBeLost({ ...idle, step: "working" })).toBe("working");
    expect(whatWouldBeLost({ ...idle, step: "review", proposals: 3 })).toBe("review");
    // Typed text does not hide the bigger loss.
    expect(whatWouldBeLost({ ...idle, step: "working", front: "Che cos'è?" })).toBe("working");
    expect(whatWouldBeLost({ ...idle, step: "review", proposals: 2, back: "Una funzione." })).toBe("review");
  });

  it("counts typed text on either side, and a new subject's name only while it is the one chosen", () => {
    expect(whatWouldBeLost({ ...idle, front: "Che cos'è?" })).toBe("typed");
    expect(whatWouldBeLost({ ...idle, back: "x" })).toBe("typed");
    expect(whatWouldBeLost({ ...idle, focus: "i limiti" })).toBe("typed");
    expect(whatWouldBeLost({ ...idle, newName: "Chimica", naming: true })).toBe("typed");
    expect(whatWouldBeLost({ ...idle, newName: "Chimica", naming: false })).toBeNull();
  });

  it("has nothing to lose in a review whose proposals were all dropped", () => {
    expect(whatWouldBeLost({ ...idle, step: "review", proposals: 0 })).toBeNull();
  });
});

describe("saveProposedInput", () => {
  const rows = [{ front: "A?", back: "B.", passageId: "p1" }];
  const made = (target: ProposalTarget) => ({ target, provider: "claude", model: "m" });

  it("saves under the subject the request was for", () => {
    expect(saveProposedInput(made({ subjectId: "ana" }), rows)).toEqual({
      subjectId: "ana",
      cards: rows,
      provider: "claude",
      model: "m",
      prompt: "cards.subject",
    });
  });

  it("saves under the request's topic, with its exam, and not under the subject", () => {
    const input = saveProposedInput(made({ subjectId: "ana", planId: "gennaio", topicId: "limiti" }), rows);
    expect(input).toMatchObject({ planId: "gennaio", topicId: "limiti" });
    expect(input).not.toHaveProperty("subjectId");
  });

  it("sends only what the cards need, never the source shown on their chip", () => {
    const [card] = saveProposedInput(made({ subjectId: "ana" }), [
      { front: "A?", back: "B.", passageId: "p1", source: { title: "Bramanti", page: 3 } } as (typeof rows)[number],
    ]).cards;
    expect(card).toEqual({ front: "A?", back: "B.", passageId: "p1" });
  });
});
