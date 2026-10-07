import { describe, expect, it } from "vitest";
import { cleanLatex, parseMathText, serializeMathText, type MathSegment } from "./mathText";

const text = (t: string): MathSegment => ({ kind: "text", text: t });
const math = (latex: string, display?: boolean): MathSegment =>
  display ? { kind: "math", latex, display } : { kind: "math", latex };

describe("cleanLatex", () => {
  it("puts braces on fractions the field wrote without them", () => {
    expect(cleanLatex("\\frac12")).toBe("\\frac{1}{2}");
    expect(cleanLatex("\\frac{a}2+\\dfrac x{\\pi}")).toBe("\\frac{a}{2}+\\dfrac{x}{\\pi}");
    expect(cleanLatex("\\frac{\\frac12}{3}")).toBe("\\frac{\\frac{1}{2}}{3}");
    expect(cleanLatex("\\frac")).toBe("\\frac");
  });
  it("drops unfilled slots, edge spaces and a lone trailing backslash", () => {
    expect(cleanLatex("\\frac{1}{\\placeholder{}}")).toBe("\\frac{1}{}");
    expect(cleanLatex("  x^2 ")).toBe("x^2");
    expect(cleanLatex("   ")).toBe("");
    expect(cleanLatex("x\\")).toBe("x");
    expect(cleanLatex("x\\\\")).toBe("x\\\\");
  });
});

describe("parseMathText", () => {
  it("splits text and inline formulas", () => {
    expect(parseMathText("so $x^2$ here")).toEqual([text("so "), math("x^2"), text(" here")]);
    expect(parseMathText("$a$$b$")).toEqual([math("a"), math("b")]);
    expect(parseMathText("plain")).toEqual([text("plain")]);
    expect(parseMathText("")).toEqual([]);
  });
  it("reads display math as one formula, across lines", () => {
    expect(parseMathText("see $$\\int_0^1 x\\,dx$$ now")).toEqual([
      text("see "),
      math("\\int_0^1 x\\,dx", true),
      text(" now"),
    ]);
    expect(parseMathText("$$a\n+b$$")).toEqual([math("a\n+b", true)]);
  });
  it("keeps unmatched and spaced dollar signs as text", () => {
    expect(parseMathText("only one $ sign")).toEqual([text("only one $ sign")]);
    expect(parseMathText("costs 5$ or 6$")).toEqual([text("costs 5$ or 6$")]);
    expect(parseMathText("$x $y$")).toEqual([text("$x "), math("y")]);
    expect(parseMathText("$a\nb$")).toEqual([text("$a\nb$")]);
    expect(parseMathText("$")).toEqual([text("$")]);
  });
  it("treats empty formulas as text", () => {
    expect(parseMathText("$$")).toEqual([text("$$")]);
    expect(parseMathText("$$ $$")).toEqual([text("$$ $$")]);
    expect(parseMathText("$ $")).toEqual([text("$ $")]);
  });
  it("reads escaped dollar signs as text and keeps escapes inside formulas", () => {
    expect(parseMathText("escaped \\$5 and \\$6")).toEqual([text("escaped $5 and $6")]);
    expect(parseMathText("$\\text{5\\$}$")).toEqual([math("\\text{5\\$}")]);
    expect(parseMathText("a\\\\$x$")).toEqual([text("a\\"), math("x")]);
    expect(parseMathText("C:\\path")).toEqual([text("C:\\path")]);
  });
});

describe("serializeMathText", () => {
  it("writes formulas inline and display math as display", () => {
    expect(serializeMathText([text("so "), math("x^{2}"), text(" here")])).toBe("so $x^{2}$ here");
    expect(serializeMathText([math("\\int x", true)])).toBe("$$\\int x$$");
  });
  it("drops empty formulas", () => {
    expect(serializeMathText([text("a "), math("  "), text("b")])).toBe("a b");
    expect(serializeMathText([math("")])).toBe("");
  });
  it("escapes dollar signs in text and inside formulas", () => {
    expect(serializeMathText([text("costs 5$")])).toBe("costs 5\\$");
    expect(serializeMathText([math("\\text{5$}")])).toBe("$\\text{5\\$}$");
    expect(serializeMathText([math("\\text{5\\$}")])).toBe("$\\text{5\\$}$");
    expect(serializeMathText([text("a\\"), math("x")])).toBe("a\\\\$x$");
  });
  it("round-trips through parse", () => {
    const cases: MathSegment[][] = [
      [text("Calcola "), math("\\frac{1}{2}"), text(" e poi semplifica")],
      [text("costs 5$, "), math("x"), text("\\")],
      [text("a\\$b "), math("y"), math("z", true)],
      [text("line one\nline two "), math("\\sqrt{2}")],
      [math("\\$"), text("$")],
    ];
    for (const segments of cases)
      expect(parseMathText(serializeMathText(segments))).toEqual(segments);
  });
});
