import { describe, expect, it } from "vitest";
import { hasMath, insertAtCaret, wrapLatex } from "./insertAtCaret";

describe("wrapLatex", () => {
  it("wraps LaTeX as inline math", () => {
    expect(wrapLatex("\\frac{1}{2}")).toBe("$\\frac{1}{2}$");
  });
  it("puts braces on fractions the field wrote without them", () => {
    expect(wrapLatex("\\frac12")).toBe("$\\frac{1}{2}$");
    expect(wrapLatex("\\frac{a}2+\\dfrac x{\\pi}")).toBe("$\\frac{a}{2}+\\dfrac{x}{\\pi}$");
    expect(wrapLatex("\\frac{\\frac12}{3}")).toBe("$\\frac{\\frac{1}{2}}{3}$");
    expect(wrapLatex("\\frac")).toBe("$\\frac$");
  });
  it("trims and ignores empty input", () => {
    expect(wrapLatex("  x^2 ")).toBe("$x^2$");
    expect(wrapLatex("   ")).toBe("");
  });
  it("drops unfilled placeholders and escapes bare dollar signs", () => {
    expect(wrapLatex("\\frac{1}{\\placeholder{}}")).toBe("$\\frac{1}{}$");
    expect(wrapLatex("\\text{5$}")).toBe("$\\text{5\\$}$");
  });
});

describe("hasMath", () => {
  it("finds closed spans", () => {
    expect(hasMath("so $x^2$ here")).toBe(true);
    expect(hasMath("$$\\int_0^1 x\\,dx$$")).toBe(true);
  });
  it("ignores prices and open spans", () => {
    expect(hasMath("it costs 5 dollars")).toBe(false);
    expect(hasMath("only one $ sign")).toBe(false);
    expect(hasMath("escaped \\$5 and \\$6")).toBe(false);
  });
});

describe("insertAtCaret", () => {
  it("inserts into an empty draft", () => {
    expect(insertAtCaret("", 0, 0, "$x$")).toEqual({ value: "$x$", caret: 3 });
  });
  it("inserts at the caret and keeps the caret after the formula", () => {
    const out = insertAtCaret("ab cd", 3, 3, "$x$");
    expect(out.value).toBe("ab $x$ cd");
    expect(out.value.slice(0, out.caret)).toBe("ab $x$");
  });
  it("replaces the selection", () => {
    expect(insertAtCaret("find X now", 5, 6, "$x$").value).toBe("find $x$ now");
  });
  it("separates from a word before the caret", () => {
    expect(insertAtCaret("area", 4, 4, "$x$").value).toBe("area $x$");
  });
  it("does not pad before punctuation", () => {
    expect(insertAtCaret("a ", 2, 2, "$x$").value).toBe("a $x$");
    expect(insertAtCaret("a .", 2, 2, "$x$").value).toBe("a $x$.");
  });
  it("clamps an out of range caret", () => {
    expect(insertAtCaret("ab", 9, 12, "$x$").value).toBe("ab $x$");
    expect(insertAtCaret("ab", -3, -1, "$x$").value).toBe("$x$ ab");
  });
  it("leaves the text alone when there is nothing to insert", () => {
    expect(insertAtCaret("ab", 1, 1, "")).toEqual({ value: "ab", caret: 1 });
  });
});
