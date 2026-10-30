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

  it("shows one chip for passages of the same section that follow each other", () => {
    const section = "8. Corpo rigido: cinematica e inerzia";
    expect(linkCitations("Vale [P1], [P2] e [P3].", () => section)).toBe(
      `Vale [${section}](cite:p1) e [${section}](cite:p3).`,
    );
  });

  it("caps a run of different sections at three chips", () => {
    expect(linkCitations("Vale [P1][P2][P3][P4][P5].", (id) => `Cap. ${id}`)).toBe(
      "Vale [Cap. 1](cite:p1)[Cap. 2](cite:p2)[Cap. 3](cite:p3).",
    );
  });

  it("keeps chips apart when words sit between them", () => {
    expect(linkCitations("Uno [P1], poi due [P2].", () => "Cap. 1")).toBe(
      "Uno [Cap. 1](cite:p1), poi due [Cap. 1](cite:p2).",
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
