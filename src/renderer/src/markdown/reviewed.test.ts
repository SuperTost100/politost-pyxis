import { describe, expect, it } from "vitest";
import { holdOpenMath, normalizeMathDelimiters } from "../../../shared/math-delimiters";
import { parseMarkdown, start, walk } from "../../../shared/markdown-tree";
import corpus from "./formula-corpus.json";
import { drawn, render, undrawn, visibleText } from "./formulaTestKit";
import { markdownSource } from "./source";

/**
 * The thirteen cases the reviews of #534 found, by reviewer and number, each as the example the review gave. CodeRabbit
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
  ];

  it("holds for every text, complete", () => {
    for (const text of texts) preserved(text, markdownSource(text), equation);
  });

  it("holds for every cut of a text that has code, while it streams", () => {
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
