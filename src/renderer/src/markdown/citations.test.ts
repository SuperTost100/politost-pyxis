import { describe, expect, it } from "vitest";
import { citedPassage, linkCitations } from "./citations";

describe("linkCitations", () => {
  it("escapes brackets in a section name so the link stays whole", () => {
    expect(linkCitations("Vedi [P1].", () => "Esercizi [svolti] \\ 2")).toBe(
      "Vedi [Esercizi &#91;svolti&#93; &#92; 2](cite:p1).",
    );
  });

  it("leaves a marker with no stored citation as plain text", () => {
    const labels = new Map([[1, "Cap. 1"]]);
    expect(linkCitations("Uno [P1], due [P2].", (id) => labels.get(id))).toBe(
      "Uno [Cap. 1](cite:p1), due &#91;P2&#93;.",
    );
  });

  it("links every marker by number when there is no resolver", () => {
    expect(linkCitations("Uno [P1; P2].")).toBe("Uno [P1](cite:p1)[P2](cite:p2).");
  });
});

describe("citedPassage", () => {
  const stored = (id: number) => (id === 1 ? "Cap. 1" : undefined);

  it("accepts a cite link only for a passage stored with the reply", () => {
    expect(citedPassage("cite:p1", stored)).toBe(1);
    expect(citedPassage("cite:p9", stored)).toBeNull();
  });

  it("takes every number when the page has no resolver, and ignores other links", () => {
    expect(citedPassage("cite:p9")).toBe(9);
    expect(citedPassage("https://example.com", stored)).toBeNull();
    expect(citedPassage(undefined, stored)).toBeNull();
    expect(citedPassage("cite:p1x", stored)).toBeNull();
  });
});
