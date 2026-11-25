import { describe, expect, it } from "vitest";
import { citedPassage, linkCitations } from "./citations";

describe("linkCitations", () => {
  it("turns each mark into an empty link and takes the space before it away", () => {
    expect(linkCitations("Il volume è l'integrale [P1]. Poi [P2] altro.", () => true)).toBe(
      "Il volume è l'integrale[](cite:p1). Poi[](cite:p2) altro.",
    );
  });

  it("splits a group into one link per passage", () => {
    expect(linkCitations("Vale [P1, P3; 2].")).toBe("Vale[](cite:p1)[](cite:p3)[](cite:p2).");
  });

  it("drops a mark for a passage the page does not know", () => {
    expect(linkCitations("Uno [P1], due [P2].", (id) => id === 1)).toBe("Uno[](cite:p1), due.");
  });

  it("leaves marks in code alone", () => {
    expect(linkCitations("Usa `a[P1]` qui [P1].", () => true)).toBe("Usa `a[P1]` qui[](cite:p1).");
  });
});

describe("citedPassage", () => {
  const stored = (id: number) => id === 1;

  it("accepts a cite link only for a passage stored with the reply", () => {
    expect(citedPassage("cite:p1", stored)).toBe(1);
    expect(citedPassage("cite:p9", stored)).toBeNull();
  });

  it("takes every number when the page knows no passages, and ignores other links", () => {
    expect(citedPassage("cite:p9")).toBe(9);
    expect(citedPassage("https://example.com", stored)).toBeNull();
    expect(citedPassage(undefined, stored)).toBeNull();
    expect(citedPassage("cite:p1x", stored)).toBeNull();
  });
});
