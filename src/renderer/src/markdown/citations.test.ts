import { describe, expect, it } from "vitest";
import { citedPassage, linkCitations } from "./citations";

describe("linkCitations", () => {
  it("turns each mark into an empty link and takes the space before it away", () => {
    expect(linkCitations("Il volume è l'integrale [P1]. Poi [P2] altro.", () => true)).toBe(
      "Il volume è l'integrale[](cite:p1). Poi[](cite:p2) altro.",
    );
  });

  it("splits a group into one link per passage", () => {
    expect(linkCitations("Vale [P1, P3; 2].", () => true)).toBe("Vale[](cite:p1)[](cite:p3)[](cite:p2).");
  });

  it("drops a mark for a passage the page does not know", () => {
    expect(linkCitations("Uno [P1], due [P2].", (id) => id === 1)).toBe("Uno[](cite:p1), due.");
  });

  it("keeps the indentation of a mark on its own line, so a list item stays whole", () => {
    expect(linkCitations("1. Primo passo.\n\n   [P1]\n\n   Ancora il primo.\n2. Secondo.", () => true)).toBe(
      "1. Primo passo.\n\n   [](cite:p1)\n\n   Ancora il primo.\n2. Secondo.",
    );
  });

  it("drops the commas and semicolons that only separate neighbouring marks, and keeps the sentence's own", () => {
    expect(linkCitations("Vale [P1], [P2]. Poi [P3]; [P4], e basta.", () => true)).toBe(
      "Vale[](cite:p1)[](cite:p2). Poi[](cite:p3)[](cite:p4), e basta.",
    );
    expect(linkCitations("Uno [P1], due.", () => true)).toBe("Uno[](cite:p1), due.");
  });

  it("leaves marks in code alone", () => {
    expect(linkCitations("Usa `a[P1]` qui [P1].", () => true)).toBe("Usa `a[P1]` qui[](cite:p1).");
  });

  it("separates citation marks written on the same line after a display formula's closing $$", () => {
    expect(linkCitations("Soluzione\n$$y(x)=Ce^{-A(x)}.$$ [P2]", () => true)).toBe(
      "Soluzione\n$$y(x)=Ce^{-A(x)}.$$\n\n[](cite:p2)",
    );
    expect(linkCitations("$$\ny(x)=Ce^{-A(x)}\n$$ [P2].", () => true)).toBe(
      "$$\ny(x)=Ce^{-A(x)}\n$$\n\n[](cite:p2).",
    );
    expect(linkCitations("Nel testo $$a$$ e $$b$$ [P2].", () => true)).toBe(
      "Nel testo $$a$$ e $$b$$[](cite:p2).",
    );
    expect(linkCitations("> $$x$$ [P1]", () => true)).toBe("> $$x$$\n\n> [](cite:p1)");
  });

  it("leaves indented code and blockquoted fenced code untouched when separating display math", () => {
    expect(linkCitations("    $$x$$ [P1]", () => true)).toBe("    $$x$$ [P1]");
    expect(linkCitations("> ```\n> $$x$$ [P1]\n> ```", () => true)).toBe("> ```\n> $$x$$ [P1]\n> ```");
    expect(linkCitations("$$x$$ [P1] `c`", () => true)).toBe("$$x$$[](cite:p1) `c`");
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
