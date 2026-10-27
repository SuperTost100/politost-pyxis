import { describe, expect, it } from "vitest";
import { displayMathLines, normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters", () => {
  it("converts inline \\( \\) to dollar math", () => {
    expect(normalizeMathDelimiters("a \\(x^2\\) b")).toBe("a $x^2$ b");
  });

  it("converts display \\[ \\] to a block equation", () => {
    expect(normalizeMathDelimiters("before\\[\\sum_i x_i\\]after")).toBe(
      "before\n$$\n\\sum_i x_i\n$$\nafter",
    );
  });

  it("leaves existing dollar delimiters alone", () => {
    const s = "inline $a$ and $$b$$";
    expect(normalizeMathDelimiters(s)).toBe(s);
  });

  it("handles all four styles in one document", () => {
    const input = [
      "Inline paren \\(E=mc^2\\)",
      "Display paren \\[\\int_0^1 t\\,dt\\]",
      "Inline dollar $x$",
      "Display dollar $$y$$",
    ].join("\n");
    const out = normalizeMathDelimiters(input);
    expect(out).toContain("$E=mc^2$");
    expect(out).toContain("$$\n\\int_0^1 t\\,dt\n$$");
    expect(out).toContain("Inline dollar $x$");
    expect(out).toContain("Display dollar $$y$$");
  });

  it("leaves delimiters inside code alone", () => {
    const fenced = "```python\nprint('[P1]')\nprint(r'\\[x\\]')\n```";
    expect(normalizeMathDelimiters(fenced)).toBe(fenced);
    const tilde = "~~~\n[P1]\n\\[x\\]\n~~~";
    expect(normalizeMathDelimiters(tilde)).toBe(tilde);
    const wider = "````\n[P1]\n````";
    expect(normalizeMathDelimiters(wider)).toBe(wider);
    const longerClose = "```\n[P1]\n````\n\\(x\\)";
    expect(normalizeMathDelimiters(longerClose)).toContain("$x$");
    expect(normalizeMathDelimiters(longerClose)).toContain("```\n[P1]\n````");
  });
});

describe("displayMathLines", () => {
  it("moves a lone $$ … $$ line onto lines of its own", () => {
    expect(displayMathLines("Testo\n\n$$ F = ma $$\n\nAltro")).toBe("Testo\n\n$$\nF = ma\n$$\n\nAltro");
    expect(displayMathLines("1. Passo\n   $$x^2$$")).toBe("1. Passo\n   $$\n   x^2\n   $$");
  });

  it("leaves inline, block and fenced math alone", () => {
    const inline = "La legge $$F=ma$$ dice";
    expect(displayMathLines(inline)).toBe(inline);
    const block = "$$\nF = ma\n$$";
    expect(displayMathLines(block)).toBe(block);
    const two = "$$a$$ e $$b$$";
    expect(displayMathLines(two)).toBe(two);
    const fenced = "```\n$$x$$\n```";
    expect(displayMathLines(fenced)).toBe(fenced);
  });

  it("leaves a formula that shares its line with inline code", () => {
    const after = "`code` $$x^2$$";
    expect(displayMathLines(after)).toBe(after);
    const before = "$$x^2$$ `code`";
    expect(displayMathLines(before)).toBe(before);
    const both = "`a` $$x^2$$ `b`";
    expect(displayMathLines(both)).toBe(both);
    expect(displayMathLines("`code`\n$$x^2$$")).toBe("`code`\n$$\nx^2\n$$");
  });
});

describe("bold markers inside math", () => {
  it("turns ** inside a formula into \\mathbf instead of two asterisk glyphs", () => {
    expect(normalizeMathDelimiters("$a \\subset **b** \\subset **c**$")).toBe(
      "$a \\subset \\mathbf{b} \\subset \\mathbf{c}$",
    );
    expect(normalizeMathDelimiters("$$\nx **y**\n$$")).toBe("$$\nx \\mathbf{y}\n$$");
  });

  it("leaves bold around a formula, bold in prose, spaced ** and code alone", () => {
    for (const same of [
      "**$x^2$** e **non** $y$",
      "$f ** g$ e $a$ ** $b$",
      "`$a **b** c$`",
      "```\n$a **b** c$\n```",
      "costa \\$5 e **forte** \\$6",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
  });
});
