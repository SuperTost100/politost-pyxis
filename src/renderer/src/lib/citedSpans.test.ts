import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { ATOM, MARK, coveredRuns, flatten, hasWords, type FlatNode } from "./citedSpans";

/** The words each run covers, for a text written with [m] for a mark and $ for a formula. */
function covered(source: string): string[] {
  const text = source.replaceAll("[m]", MARK).replaceAll("$", ATOM);
  return coveredRuns(text).map((run) =>
    (run.fallback ? "ALL: " : "") + text.slice(run.start, run.end).replaceAll(MARK, "[m]").replaceAll(ATOM, "$"),
  );
}

describe("coveredRuns", () => {
  it("covers the sentence that ends at the mark, before or after its full stop", () => {
    expect(covered("Prima frase. Il volume è l'integrale doppio dell'altezza.[m] Poi altro.")).toEqual([
      "Il volume è l'integrale doppio dell'altezza.",
    ]);
    expect(covered("Prima frase. Il volume è l'integrale [m]. Poi altro.")).toEqual(["Il volume è l'integrale"]);
  });

  it("starts after the previous mark when it is nearer than a full stop", () => {
    expect(
      covered("Torna, perché scende. L'esercizio 3 è lo stesso con $[m], e lo svolgimento in cartesiane [m] mostra la fatica."),
    ).toEqual(["L'esercizio 3 è lo stesso con $", "e lo svolgimento in cartesiane"]);
  });

  it("gives neighbouring marks the same words", () => {
    expect(covered("Uno. Per solidi con un asse di simmetria.[m][m]")).toEqual(["Per solidi con un asse di simmetria."]);
    expect(covered("Uno. Due e tre [m], [m]; [m].")).toEqual(["Due e tre"]);
    expect(coveredRuns(`Uno ${MARK}, ${MARK} due ${MARK}`).map((run) => run.marks)).toEqual([[0, 1], [2]]);
  });

  it("does not stop at an abbreviation, a page number or a decimal", () => {
    expect(covered("Come a p. 267 del libro, il fattore vale 1.5 circa [m].")).toEqual([
      "Come a p. 267 del libro, il fattore vale 1.5 circa",
    ]);
    expect(covered("Vedi es. il disco di raggio 2 [m].")).toEqual(["Vedi es. il disco di raggio 2"]);
  });

  it("takes a sentence that starts with a formula or a quote", () => {
    expect(covered("Fine. $ è continua su D [m].")).toEqual(["$ è continua su D"]);
    expect(covered("Fine. «Il fattore è lo jacobiano» [m]")).toEqual(["«Il fattore è lo jacobiano»"]);
  });

  it("covers a clause that ends in a colon", () => {
    expect(covered("Le polari convengono quando il dominio è un disco:[m] qui valgono tutte e due.")).toEqual([
      "Le polari convengono quando il dominio è un disco:",
    ]);
  });

  it("falls back to the whole block when no words come before the mark", () => {
    expect(covered("[m] Il teorema dice che vale.")).toEqual(["ALL: [m] Il teorema dice che vale."]);
    expect(covered("Una frase. [m]")).toEqual(["Una frase."]);
    expect(covered("Una frase [m]. [m]")).toEqual(["Una frase"]);
    expect(covered("[m]")).toEqual(["ALL: [m]"]);
  });

  it("stops at a line break", () => {
    expect(covered("Prima riga senza punto\nSeconda riga [m]")).toEqual(["Seconda riga"]);
  });
});

describe("flatten", () => {
  const block = (html: string) => {
    const { document } = parseHTML(`<html><body><p>${html}</p></body></html>`);
    return document.body.firstElementChild as unknown as FlatNode;
  };

  it("reads marks and formulas as one character each and keeps the nodes behind them", () => {
    const { text, pieces } = flatten(
      block('Il fattore <span class="katex"><span>ρ</span><span>ρ</span></span> è lo <em>jacobiano</em>.<span class="px-cite-mark" data-cite="3"></span>'),
    );
    expect(text).toBe(`Il fattore ${ATOM} è lo jacobiano.${MARK}`);
    expect(pieces.map((piece) => piece.kind)).toEqual(["text", "atom", "text", "text", "text", "mark"]);
    expect(coveredRuns(text)[0]).toMatchObject({ start: 0, end: text.length - 1, fallback: false });
  });

  it("reads a picture as one word, so a mark after it covers the picture", () => {
    const { text } = flatten(block('<img src="a.png" alt="Schema"> <span class="px-cite-mark" data-cite="1"></span>'));
    expect(text).toBe(`${ATOM} ${MARK}`);
    expect(hasWords(text)).toBe(true);
  });

  it("leaves out a nested list and a display formula", () => {
    const { document } = parseHTML(
      '<html><body><ul><li>Voce <span class="px-cite-mark"></span><ul><li>sotto</li></ul><span class="katex-display"><span class="katex">x</span></span></li></ul></body></html>',
    );
    const item = document.querySelector("li") as unknown as FlatNode;
    expect(flatten(item).text).toBe(`Voce ${MARK}`);
  });
});

describe("hasWords", () => {
  it("counts letters, digits and formulas as words, and marks and punctuation as none", () => {
    expect(hasWords(`${MARK}.`)).toBe(false);
    expect(hasWords(` ${MARK}, ${MARK};`)).toBe(false);
    expect(hasWords(`${ATOM}${MARK}`)).toBe(true);
    expect(hasWords(`Vale ${MARK}`)).toBe(true);
  });
});
