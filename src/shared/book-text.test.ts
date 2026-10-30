import { describe, expect, it } from "vitest";
import { topicTitle } from "./book-text";
import { resolveBookRefs } from "./math-delimiters";

describe("resolveBookRefs", () => {
  it("writes a formula reference as the number the book prints", () => {
    expect(resolveBookRefs("Il modulo è {{formula:1.5}}: |v|")).toBe("Il modulo è (1.5): |v|");
  });

  it("keeps the text of a reference link and drops the link", () => {
    expect(resolveBookRefs("come in [testo](ref:chapter/1#p2) e [la (1.2)](ref:formula/1.2).")).toBe(
      "come in testo e la (1.2).",
    );
  });

  it("leaves code and ordinary links alone", () => {
    const text = "`{{formula:1.5}}` e [sito](https://example.com)\n```\n[a](ref:chapter/1#p2)\n```";
    expect(resolveBookRefs(text)).toBe(text);
  });
});

describe("topicTitle", () => {
  it("drops the paragraph id and the heading marks", () => {
    expect(topicTitle("p2 ### Grandezze fisiche e incertezza")).toBe("Grandezze fisiche e incertezza");
  });

  it("reduces reference links to their text and keeps math", () => {
    expect(topicTitle("Un vettore in [testo](ref:chapter/1#p2) e un punto $P$")).toBe(
      "Un vettore in testo e un punto $P$",
    );
  });

  it("cuts a long line at a word and never inside a formula", () => {
    const title = topicTitle(`${"parola ".repeat(11)}il punto $P_{1}$ nello spazio`, 80);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(81);
    expect((title.match(/\$/g) ?? []).length % 2).toBe(0);
    expect(topicTitle(`${"a".repeat(76)} $x^2$ fine`, 80)).toBe(`${"a".repeat(76)}…`);
  });

  it("skips a whole display formula, not just its fence, to reach the prose after it", () => {
    expect(topicTitle("$$\n\\frac{a}{b}\n$$\nLa frazione descrive un rapporto.")).toBe("La frazione descrive un rapporto.");
    expect(topicTitle("$$x = 1$$\nPoi il testo.")).toBe("Poi il testo.");
  });

  it("is stable when run on its own output", () => {
    const once = topicTitle("p1 **Misurare** significa confrontare [testo](ref:formula/1.2) una grandezza", 40);
    expect(topicTitle(once, 40)).toBe(once);
  });
});
