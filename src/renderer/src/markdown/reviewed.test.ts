import katex from "katex";
import "katex/contrib/mhchem";
import { describe, expect, it } from "vitest";
import { repairLatexEscapes } from "../../../shared/latex-repair";
import {
  displayMathLines,
  holdOpenMath,
  normalizeMathDelimiters,
  priceFormulas,
  resolveBookRefs,
} from "../../../shared/math-delimiters";
import { end, parseMarkdown, start, walk } from "../../../shared/markdown-tree";
import corpus from "./formula-corpus.json";
import { drawn, render, undrawn, visibleText } from "./formulaTestKit";
import { markdownSource } from "./source";

/**
 * The cases the reviews of #534 found (thirteen in the first two rounds, eight in the third), by reviewer and number, each as the example the review gave. CodeRabbit
 * found six and GPT Sol seven more, all of one kind: the text repairs read Markdown by hand (dollar pairing, backticks,
 * fences, indentation) and each review found a construct that scan reads differently from the parser. The repairs now
 * ask the parser, and the two properties at the end hold for every text here and every cut of them.
 */

describe("CodeRabbit 1: a valid formula that paints KaTeX's error red", () => {
  it("is drawn, not replaced by its source", () => {
    const html = render("Vale $\\textcolor{#cc0000}{x}$ qui", false);
    expect(drawn(html)).toBe(1);
    expect(undrawn(html)).toBe(0);
    expect(html).toContain("color:#cc0000");
  });
});

describe("CodeRabbit 2: a complete formula with spaces inside its dollar signs, while a reply streams", () => {
  it("keeps its closing dollar sign, and a price stays text", () => {
    expect(holdOpenMath("Vale $ C_nH_{2n+2} $")).toBe("Vale $ C_nH_{2n+2} $");
    expect(drawn(render("Vale $ C_nH_{2n+2} $", false, true))).toBe(1);
    expect(holdOpenMath("Costa 25 $ e basta")).toBe("Costa 25 $ e basta");
  });
});

describe("CodeRabbit 3: backticks inside a formula", () => {
  it("are part of it, complete or not", () => {
    expect(holdOpenMath("Vale $\\text{`x`}$ qui")).toBe("Vale $\\text{`x`}$ qui");
    expect(drawn(render("Vale $\\text{`x`}$ qui", false, true))).toBe(1);
    expect(holdOpenMath("Vale $\\text{`x`}")).toBe("Vale […](pyxis-math:inline:10)");
  });
});

describe("CodeRabbit 4: a chemistry example inside a longer fence", () => {
  it("is code, and a standalone block still is a formula", () => {
    const example = "````\n```\n\\ce{H2O}\n```\n````";
    expect(markdownSource(example)).toBe(example);
    expect(normalizeMathDelimiters("```\n\\ce{H2O}\n```")).toBe("$$\n\\ce{H2O}\n$$");
  });
});

describe("CodeRabbit 5: prose that starts with a text command", () => {
  it("is not a formula", () => {
    expect(normalizeMathDelimiters("\\textbf{Nota:} valore nullo")).toBe("\\textbf{Nota:} valore nullo");
    expect(normalizeMathDelimiters("\\vec{v}")).toBe("$\\vec{v}$");
  });
});

describe("CodeRabbit 6: a check marker at the end of a paragraph with an open formula", () => {
  it("leaves the formula held", () => {
    const step = "$2 + 2 = 4$";
    const source = markdownSource(`Il primo passo è ${step} e poi $x = `, undefined, true, [step]);
    expect(source).toContain("pyxis-math:inline:");
    expect(source).not.toContain("$x =");
    expect(source).toContain("[check](mathcheck:0)");
  });
});

describe("GPT Sol 1: a price, then a fenced Python block with a dollar sign in it", () => {
  const python = "```python\ns = r'\\(x\\)' + '$'\n```";
  const text = `Budget: $5.\n${python}`;

  it("keeps the code as written, so the runnable block gets what the model wrote", () => {
    for (const writing of [false, true]) {
      const source = markdownSource(text, undefined, writing);
      expect(source).toContain(python);
      expect(source).not.toContain("$x$");
    }
  });
});

describe("GPT Sol 2: a price at the end of a paragraph, then a `$$` block, while it streams", () => {
  const text = "Budget: $5.\n$$\nx + y\n$$\nThen more text.";

  it("never takes the first dollar of the block for the end of a formula, in any cut", () => {
    for (let end = 8; end <= text.length; end += 1) {
      const cut = text.slice(0, end);
      const html = render(cut, false, true);
      expect(html, cut).not.toContain("katex-error");
      // The block is drawn, or waits as one placeholder; its fence is never text.
      expect(visibleText(html), cut).not.toContain("$$");
      if (end >= "Budget: $5.".length) expect(visibleText(html), cut).toContain("Budget: $5.");
    }
    expect(drawn(render(text, false, true))).toBe(1);
  });
});

describe("GPT Sol 3: a price with words after it, and a formula that opens with a space", () => {
  it("holds nothing of `The book costs $25 and includes shipping.` while it streams", () => {
    const text = "The book costs $25 and includes shipping.";
    for (let end = 1; end <= text.length; end += 1) expect(holdOpenMath(text.slice(0, end)), text.slice(0, end)).toBe(text.slice(0, end));
  });

  it("holds `The result is $ x^2 + ` instead of showing its LaTeX", () => {
    expect(holdOpenMath("The result is $ x^2 + ")).toBe("The result is […](pyxis-math:inline:7)");
    expect(drawn(render("The result is $ x^2 + 1 $ here.", false, true))).toBe(1);
  });
});

describe("GPT Sol 4: a backtick in a formula that is not finished", () => {
  it("does not split the formula, whatever length it has reached", () => {
    const text = "Vale $\\text{`x`} + 1$ qui";
    for (let end = "Vale $\\".length; end < text.indexOf("$ qui"); end += 1) {
      const html = render(text.slice(0, end), false, true);
      expect(html, text.slice(0, end)).not.toContain("<code");
      expect(visibleText(html), text.slice(0, end)).not.toMatch(/[$`\\]/);
    }
    expect(drawn(render(text, false, true))).toBe(1);
  });
});

describe("GPT Sol 5: a LaTeX example indented by four spaces", () => {
  it("is a code block, and stays as written", () => {
    for (const same of ["Esempio:\n\n    \\vec{v} = \\frac{1}{2}\n\nFine.", "    \\vec{v} = \\frac{1}{2}", "    \\ce{H2O}\n"]) {
      expect(normalizeMathDelimiters(same)).toBe(same);
      expect(markdownSource(same)).toBe(same);
    }
  });
});

describe("GPT Sol 6: a reply that is only an equation", () => {
  it("is a display formula, not an inline one", () => {
    expect(normalizeMathDelimiters("\\ce{H2O}")).toBe("$$\n\\ce{H2O}\n$$");
    expect(normalizeMathDelimiters("\\ce{CH4 + 2O2 -> CO2 + 2H2O}\n")).toBe("$$\n\\ce{CH4 + 2O2 -> CO2 + 2H2O}\n$$\n");
  });
});

describe("CodeRabbit round 3, 1: a display formula in a block quote", () => {
  const quoted = "> $$\n> x + y\n> $$";

  it("is left as written, complete and while it streams", () => {
    expect(normalizeMathDelimiters(quoted)).toBe(quoted);
    expect(displayMathLines(quoted)).toBe(quoted);
    expect(holdOpenMath(quoted)).toBe(quoted);
    expect(drawn(render(quoted, false, true))).toBe(1);
    // Still open: a placeholder.
    expect(holdOpenMath("> $$\n> x +")).toBe("> […](pyxis-math:display:6)");
  });

  it("is repaired in a quote as at the root, when it shares a line with its fence", () => {
    expect(displayMathLines("> $$a,\n> b\n> $$")).toBe("> $$\n> a,\n> b\n> $$");
    expect(displayMathLines("> $$\n> a,\n> b$$")).toBe("> $$\n> a,\n> b\n> $$");
    expect(displayMathLines("$$\na,\nb$$")).toBe("$$\na,\nb\n$$");
  });
});

describe("CodeRabbit round 3, 2: a space-padded formula after a number", () => {
  it("is a formula; a price before words is not", () => {
    expect(drawn(render("Step 2 $ x+1 $", false))).toBe(1);
    expect(normalizeMathDelimiters("Step 2 $ x+1 $")).toBe("Step 2 $ x+1 $");
    expect(normalizeMathDelimiters("costa 25 $ e l'area è $x$.")).toBe("costa 25 \\$ e l'area è $x$.");
  });
});

describe("CodeRabbit round 3, 3: an unmatched \\( in a list item", () => {
  it("does not take the \\) of the next item", () => {
    expect(normalizeMathDelimiters("- Note \\(\n- Use \\(x\\)")).toBe("- Note \\(\n- Use $x$");
  });
});

describe("CodeRabbit round 3, 4: a price and a code span with an operator in it", () => {
  it("holds neither, and still holds a formula that is being written", () => {
    expect(holdOpenMath("It costs $9; use `x+y`")).toBe("It costs $9; use `x+y`");
    expect(holdOpenMath("It costs $9 +")).toBe("It costs […](pyxis-math:inline:3)");
  });
});

describe("CodeRabbit round 3, 5: indented code in a block quote", () => {
  it("is code, and its book reference stays as written", () => {
    for (const same of [">     {{formula:1}}", "- item\n\n      {{formula:2}}", "1.     {{formula:3}}\n"]) {
      expect(resolveBookRefs(same)).toBe(same);
      expect(markdownSource(same)).toBe(same);
    }
    expect(resolveBookRefs("vedi {{formula:1}} qui")).toBe("vedi eq. 1 qui");
  });
});

describe("CodeRabbit round 3, 6: a \\times whose backslash arrived as a tab, while it streams", () => {
  it("is held as the formula it is, and a plain price is not", () => {
    expect(markdownSource("Vale $5\times 2", undefined, true)).toContain("pyxis-math:inline:");
    expect(markdownSource("Vale $5\times 2", undefined, true)).not.toContain("imes");
    expect(markdownSource("Costa $5", undefined, true)).toBe("Costa $5");
  });
});

describe("CodeRabbit round 3, 7: two check markers in one paragraph", () => {
  it("are both there, in the one paragraph", () => {
    const source = markdownSource("$a = 1$ e $b = 2$ e $c = ", undefined, true, ["$a = 1$", "$b = 2$"]);
    expect(source).toContain("[check](mathcheck:0) [check](mathcheck:1)");
    expect(source.match(/mathcheck:/g)).toHaveLength(2);
    expect(source).toContain("pyxis-math:inline:");
  });
});

describe("Catch-up review of #558, 9: a formula whose closing dollar starts the next line", () => {
  it("is a formula unless a number says its first dollar is a price", () => {
    expect(drawn(render("Value $x\n$ is valid.", false))).toBe(1);
    expect(priceFormulas("Value $x\n$ is valid.")).toEqual([]);
    expect(priceFormulas("Costa 5 $\n$x$ vale")).toEqual([8]);
  });
});

describe("Catch-up review of #558, 10: a \\[ … \\] in a quote, and two \\( … \\) that touch", () => {
  it("keeps the display formula in its quote", () => {
    const html = render("> \\[x+1\\]\n> explanation", false);
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html.indexOf("katex-display")).toBeLessThan(html.indexOf("</blockquote>"));
    expect(html.indexOf("explanation")).toBeLessThan(html.indexOf("</blockquote>"));
  });

  it("draws two formulas, and one beside a $ formula, apart", () => {
    expect(drawn(render("In prose \\(x\\)\\(y\\) here.", false))).toBe(2);
    expect(drawn(render("Then $a$\\(b\\)\\(c\\)$d$.", false))).toBe(4);
    expect(undrawn(render("In prose \\(x\\)\\(y\\) here.", false))).toBe(0);
  });
});

describe("Catch-up review of #558, 8: a citation marker inside a formula", () => {
  it("is LaTeX to draw, and one in prose is still a link", () => {
    expect(markdownSource("See $\\text{`[P1]`}$ and [P1].")).toBe("See $\\text{`[P1]`}$ and [P1](cite:p1).");
  });
});

// GPT Sol 7, the one report for a lesson full of broken formulas, is in formulaFailure.test.ts.

/** Code spans and blocks of a text, as the parser reads them. */
function codeOf(text: string): Array<{ type: string; value: string; at: number }> {
  const found: Array<{ type: string; value: string; at: number }> = [];
  walk(parseMarkdown(text), (node) => {
    if (node.type !== "code" && node.type !== "inlineCode") return;
    found.push({ type: node.type, value: node.value ?? "", at: start(node) });
    return false;
  });
  return found;
}

/** The formulas of a text, as the parser reads them. */
const formulasOf = (text: string) => {
  const found: string[] = [];
  walk(parseMarkdown(text), (node) => {
    if (node.type === "inlineMath" || node.type === "math") found.push(node.value ?? "");
  });
  return found;
};

describe("property (a): the code the parser finds in a text is the same after preprocessing", () => {
  /** Every code span and block of `original` is in `processed`, in order, but the ones `exempt` names. */
  function preserved(original: string, processed: string, exempt: (code: { type: string; value: string; at: number }) => boolean) {
    const after = codeOf(processed);
    let from = 0;
    for (const code of codeOf(original)) {
      if (exempt(code)) continue;
      const at = after.findIndex((item, index) => index >= from && item.type === code.type && item.value === code.value);
      expect(at, `code ${JSON.stringify(code.value)} of ${JSON.stringify(original.slice(0, 80))}`).toBeGreaterThanOrEqual(0);
      from = at + 1;
    }
  }
  // The one deliberate change: a fence that holds only an equation is a formula.
  const equation = (code: { type: string; value: string }) => code.type === "code" && /^\\(?:ce|pu)\{[^\n]*\}$/.test(code.value.trim());

  const texts = [
    ...corpus.texts.map((entry) => entry.text),
    "Budget: $5.\n```python\ns = r'\\(x\\)' + '$'\n```",
    "Uso `$x` e `\\(y\\)` poi $z^2$ e \\(w\\), costa 25 $ qui.",
    "Vale $\\text{`x`}$ e `$y$` e \\(`z`\\).",
    "Prima\n\n    \\vec{v} = \\(x\\) $y$\n\nDopo \\[a\\]",
    "````\n```\n\\ce{H2O}\n```\n````\n\n~~~tex\n$$x$$\n~~~",
    "- elenco\n\n      codice $a$ \\(b\\)\n\n- altro `\\[c\\]`",
    "> citazione `$a$`\n>\n> ```\n> \\(b\\)\n> ```",
    "See $\\text{`[P1]`}$ and `[P2]` and [P1].",
  ];

  it("holds for every text, complete", () => {
    for (const text of texts) preserved(text, markdownSource(text), equation);
  });

  it("holds for every cut of a text that has code, while it streams", { timeout: 60_000 }, () => {
    for (const text of texts.filter((item) => /`|\n {4}/.test(item))) {
      for (let end = 6; end <= text.length; end += text.length > 600 ? 41 : 3) {
        const cut = text.slice(0, end);
        const processed = markdownSource(cut, undefined, true);
        // Code in the unfinished formula at the end of the cut waits with it, and is not shown.
        const opener = Math.max(cut.lastIndexOf("$"), cut.lastIndexOf("\\("));
        const waits = (code: { at: number }) => processed.includes("pyxis-math:") && opener !== -1 && code.at > opener;
        preserved(cut, processed, (code) => equation(code) || waits(code));
      }
    }
  });
});

describe("property (b): a price is never maths or a placeholder, in a complete text or in a cut", () => {
  // The text, and the formulas it has on purpose, after the index where the first of them starts.
  const cases: Array<[string, string[], number]> = [
    ["Budget: $5.", [], 0],
    ["The book costs $25 and includes shipping.", [], 0],
    ["costa 25 $", [], 0],
    ["Costa 25 $ e basta", [], 0],
    ["Costs $5 and $7 per kg.", [], 0],
    ["Il prezzo è \\$25 e \\$30.", [], 0],
    ["The book costs $25 and the area is $x^2$.", ["x^2"], "The book costs $25 and the area is ".length],
    ["costa 25 $ e l'area è $x^2$.", ["x^2"], "costa 25 $ e l'area è ".length],
    ["Budget $5.\n\nThen $x^2 + 1$ here.", ["x^2 + 1"], "Budget $5.\n\nThen ".length],
    ["A cylinder costs $25 and holds \\(\\ce{CO2}\\) too.", ["\\ce{CO2}"], "A cylinder costs $25 and holds ".length],
    // Prices with punctuation after the dollar sign, from the walk of the dev.13 build.
    ["Costa 12 $ oppure 15 $, e l'area vale $x^2$.", ["x^2"], "Costa 12 $ oppure 15 $, e l'area vale ".length],
    ["Due biglietti da 7 $ fanno 12 $.", [], 0],
    ["Costa 12 $ e lo sconto è del 10 %, quindi paghi $10{,}8$ euro.", ["10{,}8"], "Costa 12 $ e lo sconto è del 10 %, quindi paghi ".length],
    [
      "Due biglietti da 7 $ fanno 12 $. Costa 12 $ e lo sconto è del 10 %, quindi paghi $10{,}8$ euro.",
      ["10{,}8"],
      "Due biglietti da 7 $ fanno 12 $. Costa 12 $ e lo sconto è del 10 %, quindi paghi ".length,
    ],
    ["It costs $12, and $x^2$ here.", ["x^2"], "It costs $12, and ".length],
    ["It costs $12. Then $x^2$ here.", ["x^2"], "It costs $12. Then ".length],
  ];

  it.each(cases)("%s: the formulas are the ones meant, and nothing else", (text, formulas) => {
    expect(formulasOf(markdownSource(text))).toEqual(formulas);
    expect(formulasOf(normalizeMathDelimiters(text))).toEqual(formulas);
  });

  it.each(cases)("%s: no cut is held before its first formula starts", (text, _formulas, at) => {
    for (let end = 1; end <= text.length; end += 1) {
      const held = holdOpenMath(text.slice(0, end)).includes("pyxis-math:");
      if (end <= at) expect(held, JSON.stringify(text.slice(0, end))).toBe(false);
      // Nothing of a text without formulas is held at any length; a text with them may hold only the formula being written.
      if (at === 0) expect(held, JSON.stringify(text.slice(0, end))).toBe(false);
    }
  });
});

describe("property (c): a repair only adds formulas, never takes one away", () => {
  /**
   * The formulas of `original` that KaTeX draws and the repairs have no reason to change, by content. Not these: a price
   * the parser paired with the next dollar sign (the one repair that un-maths a formula, by design), a formula with
   * Markdown bold or a corrupted escape in it (rewritten on purpose), and a `$$` block whose first line the parser took
   * for an info string.
   */
  const draws = new Map<string, boolean>();
  function formulasOf(original: string): Array<{ value: string; at: number }> {
    const prices = priceFormulas(original);
    const found: Array<{ value: string; at: number }> = [];
    walk(parseMarkdown(original), (node) => {
      if (node.type !== "inlineMath" && node.type !== "math") return;
      const value = (node.value ?? "").trim();
      if (!value || node.meta || value.includes("**") || repairLatexEscapes(value) !== value) return;
      if (prices.includes(start(node))) return;
      // Words and nothing mathematical: the parser's pairing of the prose between two formulas, which a repair of the
      // pairing undoes.
      if (/\p{L}{2,}/u.test(value) && /\s/.test(value) && !/[=+*/^_\\{}<>-]/.test(value)) return;
      // A block that is not closed yet is still being written.
      const lines = original.slice(start(node), end(node)).split("\n");
      if (node.type === "math" && !(lines.length > 1 && /^[ \t>]*\$+[ \t]*$/.test(lines[lines.length - 1]!))) return;
      const key = `${node.type}:${value}`;
      if (!draws.has(key)) {
        try {
          katex.renderToString(value, { displayMode: node.type === "math", throwOnError: true, strict: "ignore" });
          draws.set(key, true);
        } catch {
          draws.set(key, false);
        }
      }
      if (draws.get(key)) found.push({ value, at: start(node) });
    });
    return found;
  }

  /** The formulas of `original` missing from `processed`, but those at or after `from` of the original. */
  function lost(original: string, processed: string, from = Infinity): string[] {
    const after = new Map<string, number>();
    walk(parseMarkdown(processed), (node) => {
      if (node.type !== "inlineMath" && node.type !== "math") return;
      const value = (node.value ?? "").trim();
      after.set(value, (after.get(value) ?? 0) + 1);
    });
    const missing: string[] = [];
    for (const { value, at } of formulasOf(original)) {
      if (at >= from) continue;
      const left = after.get(value) ?? 0;
      if (left === 0) missing.push(value);
      else after.set(value, left - 1);
    }
    return missing;
  }

  const examples = [
    "> $$\n> x + y\n> $$",
    "Step 2 $ x+1 $ e $ y $",
    "- Note \\(\n- Use \\(x\\)",
    "It costs $9; use `x+y` e $z^2$",
    "Vale $5\\times 2$ e `$a$`",
    "- elenco\n\n  > $$\n  > a\n  > $$\n\n- $x$ e \\(y\\)",
    "Budget $5.\n$$\nx + y\n$$\nPoi $\\ce{H2O}$",
    "1. Passo $a$\n   $$b$$\n2. Passo \\[c\\]",
    "| a | $b$ |\n|---|---|\n| \\(c\\) | $d$ |",
    "Valore $\\text{`x`}$ e $25\\ \\$ + 1$",
    "$$\n25\\ \\$\n$$\n\ncosta \\(25\\ \\$\\)",
    "Value $x\n$ is valid.",
    "> \\[x+1\\]\n> explanation",
    "In prose \\(x\\)\\(y\\) here, $a$\\(b\\).",
  ];

  it("holds for the examples, complete", () => {
    for (const text of examples) expect(lost(text, markdownSource(text)), text).toEqual([]);
  });

  it("holds for the 71 recorded texts, complete", { timeout: 60_000 }, () => {
    for (const entry of corpus.texts) {
      const processed = entry.inline ? normalizeMathDelimiters(entry.text) : markdownSource(entry.text);
      expect(lost(entry.text, processed), entry.id).toEqual([]);
    }
  });

  it("holds for every cut of the examples and the long recorded texts, for the formulas complete in the cut", { timeout: 60_000 }, () => {
    const longer = corpus.texts.filter((entry) => !entry.inline && entry.text.length > 900).map((entry) => entry.text);
    for (const text of [...examples, ...longer]) {
      for (let end = 3; end <= text.length; end += text.length > 900 ? 61 : 1) {
        const cut = text.slice(0, end);
        const repaired = repairLatexEscapes(cut);
        const held = holdOpenMath(repaired).indexOf("[…](pyxis-math");
        // What the placeholder replaces is the formula being written, not a complete one.
        expect(lost(cut, markdownSource(cut, undefined, true), held === -1 ? Infinity : held), JSON.stringify(cut)).toEqual([]);
      }
    }
  });
});
