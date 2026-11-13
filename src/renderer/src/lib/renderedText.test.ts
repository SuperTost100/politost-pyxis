import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { InlineMarkdown } from "../components/InlineMarkdown";
import { renderedText, wordCount, type RenderedNode } from "./renderedText";

type Drawn = RenderedNode & { textContent: string };

/** The tree the lesson page draws for this Markdown, formulas included. */
const draw = (markdown: string): Drawn => {
  const { document } = parseHTML(`<html><body><div>${renderToStaticMarkup(createElement(InlineMarkdown, null, markdown))}</div></body></html>`);
  return document.body.firstElementChild as unknown as Drawn;
};

describe("renderedText", () => {
  it("reads a formula once, as its TeX source", () => {
    const tree = draw("Intorni e distanza in $\\mathbb{R}^n$");
    // The tree's own textContent holds the formula three times, which is what the lesson outline showed.
    expect(tree.textContent).toMatch(/Rn\\mathbb\{R\}\^nRn/);
    expect(renderedText(tree).trim()).toBe("Intorni e distanza in \\mathbb{R}^n");
  });

  it("lets the caller choose what a formula becomes", () => {
    expect(renderedText(draw("Sia $x$ e $y_1$."), (tex) => `$${tex}$`).trim()).toBe("Sia $x$ e $y_1$.");
  });

  it("keeps the drawn text of a formula that has no TeX annotation", () => {
    const { document } = parseHTML(
      '<html><body><div><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html">x</span></span></div></body></html>',
    );
    expect(renderedText(document.body.firstElementChild as unknown as RenderedNode)).toBe("x");
  });
});

describe("wordCount", () => {
  it("counts each formula as one word, not three copies of its symbols", () => {
    expect(wordCount(draw("Sia X un insieme di punti e sia x un suo punto."))).toBe(12);
    const withFormulas = draw("Sia $X \\subseteq \\mathbb{R}^n$ un insieme di punti e sia $\\mathbf{x}$ un suo punto.");
    expect(wordCount(withFormulas)).toBe(12);
    // What the page counted before: every copy of every formula.
    expect(withFormulas.textContent.split(/\s+/).filter(Boolean).length).toBeGreaterThan(12);
  });

  it("keeps a formula that touches punctuation in the same word", () => {
    expect(wordCount(draw("Vale ($x$), cioè $y$."))).toBe(4);
  });

  it("counts a section of many formulas by its words", () => {
    const section = Array.from({ length: 40 }, (_, i) => `Il valore $a_{${i}} = \\frac{${i}}{n}$ cresce.`).join("\n\n");
    expect(wordCount(draw(section))).toBe(40 * 4);
  });
});
