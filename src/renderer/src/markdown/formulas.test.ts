import { describe, expect, it } from "vitest";
import corpus from "./formula-corpus.json";
import { drawn, render, undrawn, visibleText } from "./formulaTestKit";
import { formulaHtml } from "./formulaHtml";
import { markdownSource } from "./source";

/**
 * The answers of the four AI tools (Claude Haiku and Sonnet, ChatGPT Luna and Terra, Cursor Grok, Gemini Hydrogen and
 * Argon) to the same course material, recorded on 2026-11-19: the texts that drew an error or showed a formula as text,
 * and the most formula-heavy text of every place the app shows AI text. One more, recorded on 2026-11-25 (its own
 * `recorded`), is a lesson part of ChatGPT's whose display formulas open with a line break before `e^z` and `u=`, which
 * an earlier repair drew as `\ne^z` and `\nu=`. Every formula goes through the pipeline the views use, so a change that
 * breaks one of them fails here.
 */
type Entry = {
  id: string;
  tool: string;
  lang: string;
  place: string;
  /** Drawn like a quiz option or a caption: in a button or a label, with no `displayMathLines`. */
  inline: boolean;
  /** The formulas remark-math finds in the text as the renderer prepares it. */
  formulas: number;
  /** Dollar signs left in the text around them: prices. */
  dollars: number;
  /** Formulas KaTeX cannot draw even so (a typo of the model's). */
  undrawable: number;
  text: string;
};
const entries = corpus.texts as Entry[];

describe("the corpus of recorded AI answers", () => {
  it("is a real corpus", () => {
    expect(entries.length).toBeGreaterThan(60);
    expect(new Set(entries.map((entry) => entry.tool))).toEqual(new Set(["claude", "codex", "agent", "antigravity"]));
    expect(new Set(entries.map((entry) => entry.lang))).toEqual(new Set(["it", "en"]));
    expect(entries.reduce((sum, entry) => sum + entry.formulas, 0)).toBeGreaterThan(600);
  });

  it.each(entries.map((entry) => [entry.id, entry] as const))("%s draws every formula it has", (_id, entry) => {
    const html = render(entry.text, entry.inline);
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("cc0000");
    expect(undrawn(html)).toBe(entry.undrawable);
    expect(drawn(html)).toBe(entry.formulas - entry.undrawable);
    // Nothing is left as text: no backslash command, no dollar sign but the prices.
    const text = visibleText(html);
    expect(text.match(/\\[A-Za-z]{2,}/g) ?? []).toEqual([]);
    expect((text.match(/\$/g) ?? []).length).toBe(entry.dollars);
  });
});

describe("the corpus and the line breaks before a formula", () => {
  // A line break the repair took for the backslash of `\ne` draws ≠ where the formula had `e`. A relation never opens a display
  // formula or one of its rows, and never takes an exponent or an index, so no drawn formula of the corpus may show one there.
  it.each(entries.map((entry) => [entry.id, entry] as const))("%s draws no relation where the text had a line break", (_id, entry) => {
    const html = render(entry.text, entry.inline);
    const display = [...html.matchAll(/<span class="katex-display">[\s\S]*?<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map((m) => m[1]!);
    const all = [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map((m) => m[1]!);
    expect(display.filter((latex) => /^\s*\\(?:ne|neq|ni|notin)(?![A-Za-z])/.test(latex))).toEqual([]);
    expect(all.filter((latex) => /\\(?:ne|neq|ni|notin)(?![A-Za-z])\s*[\^_]/.test(latex))).toEqual([]);
  });
});

describe("a formula KaTeX cannot draw", () => {
  it("shows its source in the text's own colour, never in an error colour", () => {
    // A parse error (an open brace) and an unknown command, which KaTeX draws with that command in red.
    for (const [text, source] of [
      ["Vale $\\frac{1}{$ qui", "\\frac{1}{"],
      ["Vale $a \\badcommand b$ qui", "a \\badcommand b"],
    ] as const) {
      const html = render(text, false);
      expect(html).toContain(`<span class="px-formula-source">${source}</span>`);
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("cc0000");
    }
  });

  it("does so for a display formula too, and keeps the dollar sign it was written with", () => {
    // An unknown command, which KaTeX draws in red, and an open brace, which it refuses.
    for (const body of ["\\badcommand + 25\\ \\$", "\\frac{1}{ + 25\\ \\$"]) {
      const html = render(`Prima\n\n$$\n${body}\n$$\n\nDopo`, false);
      expect(html).toContain(`<span class="px-formula-source is-display">${body}</span>`);
      expect(html).not.toContain("cc0000");
    }
  });

  it("keeps a display formula's block layout outside Markdown too (a quiz option, a graph label)", () => {
    expect(formulaHtml("\\frac{1}{", { displayMode: true })).toBe('<span class="px-formula-source is-display">\\frac{1}{</span>');
    expect(formulaHtml("\\frac{1}{")).toBe('<span class="px-formula-source">\\frac{1}{</span>');
  });

  it("leaves the formulas around it drawn", () => {
    const html = render("$x^2$ e $\\badcommand$ e $y^2$", false);
    expect(drawn(html)).toBe(2);
    expect(undrawn(html)).toBe(1);
  });
});

describe("a formula KaTeX draws without a failure", () => {
  it("is not replaced by its source because of the colour it paints, even KaTeX's own error red", () => {
    const html = render("Vale $\\textcolor{#cc0000}{x}$ e $\\color{#cc0000} y^2$ e $$\\textcolor{#cc0000}{z}$$", false);
    expect(undrawn(html)).toBe(0);
    expect(drawn(html)).toBe(3);
    expect(html).toContain("color:#cc0000");
  });
});

describe("a display formula that opens on a line of its own", () => {
  // From a lesson of dev.13, where the line break before `e^{-st}` was drawn as ≠.
  it.each([
    "Sostituendo nella definizione, l'integranda diventa\n\n$$\ne^{-st} e^{2t} = e^{(2-s)t}.\n$$",
    "Sostituendo nella definizione, l'integranda diventa\n$$\ne^{-st} e^{2t} = e^{(2-s)t}.$$",
    "La soluzione è\n\n$$\nu(t) = e^{t}\n$$",
  ])("draws the formula as written: %j", (text) => {
    const html = render(text, false);
    const latex = [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map((m) => m[1]!.trim());
    expect(latex).toEqual([text.slice(text.indexOf("$$") + 3).replace(/\n?\$\$$/, "").trim()]);
    expect(html).not.toContain("≠");
  });
});

describe("prices with punctuation after the dollar sign", () => {
  // From the walk of the dev.13 build: a price followed by a comma or a full stop paired with the next dollar sign.
  it.each([
    ["Costa 12 $ oppure 15 $, e l'area vale $x^2$.", ["x^2"], 2],
    ["Due biglietti da 7 $ fanno 12 $.", [], 2],
    ["Costa 12 $ e lo sconto è del 10 %, quindi paghi $10{,}8$ euro.", ["10{,}8"], 1],
    [
      "Costa 12 $ oppure 15 $, e l'area vale $x^2$. Due biglietti da 7 $ fanno 12 $. Costa 12 $ e lo sconto è del 10 %, quindi paghi $10{,}8$ euro.",
      ["x^2", "10{,}8"],
      5,
    ],
    ["It costs $12, and $x^2$ here.", ["x^2"], 1],
    ["$5$, $7$.", ["5", "7"], 0],
  ])("%s: the prices are text and the formulas are drawn", (text, formulas, prices) => {
    for (const writing of [false, true]) {
      const html = render(text, false, writing);
      const latex = [...html.matchAll(/<annotation encoding="application\/x-tex">([^<]*)<\/annotation>/g)].map((m) => m[1]);
      expect(latex).toEqual(formulas);
      expect(undrawn(html)).toBe(0);
      expect(html).not.toContain("pyxis-math");
      expect(visibleText(html).match(/\$/g) ?? []).toHaveLength(prices);
    }
  });
});

describe("an answer that is still being written", () => {
  // Claude's chat answer (display formulas on their own lines, a price), ChatGPT's (formulas in \( \) and \[ \]), a
  // lesson part of ChatGPT's (display formulas that share the $$ line with their first and last line).
  const written = ["claude-it-chat-answer", "codex-it-chat-answer", "codex-en-lesson-prose"].map((id) => {
    const entry = entries.find((item) => item.id.startsWith(id));
    expect(entry, id).toBeDefined();
    return [id, entry!] as const;
  });

  it.each(written)("%s never shows half a formula as source or as an error, at any length", { timeout: 30_000 }, (_id, entry) => {
    const text = entry.text.slice(0, 2400);
    // A prefix every 11 characters, which cuts the answer inside every formula and most delimiters.
    for (let end = 12; end < text.length; end += 11) {
      const html = render(text.slice(0, end), false, true);
      expect(html, `at ${end}`).not.toContain("katex-error");
      expect(html, `at ${end}`).not.toContain("cc0000");
      expect(undrawn(html), `at ${end}`).toBe(0);
      const visible = visibleText(html);
      expect(visible.match(/\\[A-Za-z]{2,}/g) ?? [], `at ${end}`).toEqual([]);
      // A price in the answer is the only dollar sign a reader may see, and a dollar sign with the digits of a number after
      // it at the end of the cut, which may be a price too until a command or an operator tells that it is not.
      expect((visible.replace(/\$[\d.,]*\s*$/, "").match(/\$/g) ?? []).length, `at ${end}`).toBeLessThanOrEqual(entry.dollars);
    }
  });

  it("shows the whole text when it is finished", () => {
    const entry = written[0]![1];
    expect(render(entry.text, false, true)).toBe(render(entry.text, false, false));
  });
});

describe("the text of a reply with a check marker", () => {
  const step = "$2 + 2 = 4$";

  it("keeps a formula that is open at the end of the paragraph a placeholder", () => {
    const text = `Il primo passo è ${step} e poi $x = `;
    const source = markdownSource(text, undefined, true, [step]);
    expect(source).not.toContain("$x =");
    expect(source).toContain("pyxis-math:inline:");
    expect(source).toContain("[check](mathcheck:0)");
    // The marker follows the placeholder, in a paragraph of its own.
    expect(source.indexOf("pyxis-math")).toBeLessThan(source.indexOf("mathcheck"));
  });

  it("puts the marker after the paragraph of its step, as it always did", () => {
    expect(markdownSource(`Prima ${step} qui.\n\nDopo.`, undefined, false, [step])).toBe(
      `Prima ${step} qui.\n\n[check](mathcheck:0)\n\n\n\nDopo.`,
    );
    expect(markdownSource(`Prima ${step}.`, undefined, false, [step, "non c'è"])).toBe(`Prima ${step}.\n\n[check](mathcheck:0)\n\n`);
  });

  it("puts two markers of one paragraph together, and never draws a formula it has cut", () => {
    const source = markdownSource("$a = 1$ e $b = 2$ e $c = ", undefined, true, ["$a = 1$", "$b = 2$"]);
    // Both markers, in the one paragraph, after the placeholder of the formula being written.
    expect(source).toContain("[…](pyxis-math:inline:4)\n\n[check](mathcheck:0) [check](mathcheck:1)");
    const html = render(source, false);
    expect(html).not.toContain("katex-error");
    expect(visibleText(html)).not.toContain("$");
  });
});
