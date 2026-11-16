import { describe, expect, it } from "vitest";
import { answerReading, formulaWords } from "./math-words";

describe("formulaWords", () => {
  const both = (latex: string) => [formulaWords(latex, "it"), formulaWords(latex, "en")];

  it("reads an integral with its limits, its body and its differential", () => {
    expect(both("\\int_{0}^{1}x^{2}\\,\\mathrm{d}x")).toEqual([
      "integrale da 0 a 1 di x al quadrato in dx",
      "integral from 0 to 1 of x squared dx",
    ]);
    expect(both("\\int \\frac{1}{x}\\,\\mathrm{d}x")).toEqual(["integrale di 1 fratto x in dx", "integral of 1 over x dx"]);
  });

  it("reads powers, indices and the signs between terms", () => {
    expect(both("t^{3}-t^{2}+1")).toEqual(["t al cubo meno t al quadrato più 1", "t cubed minus t squared plus 1"]);
    expect(both("x_{0}+v_0t")).toEqual(["x pedice 0 più v pedice 0 t", "x sub 0 plus v sub 0 t"]);
    expect(both("\\mathrm{e}^{-x}")).toEqual(["e alla (meno x)", "e to the (minus x)"]);
    expect(both("2x\\le 3,5")).toEqual(["2x minore o uguale a 3,5", "2x less than or equal to 3,5"]);
    expect(both("90^{\\circ}")).toEqual(["90 gradi", "90 degrees"]);
    expect(both("f^{\\prime}\\left(x\\right)")).toEqual(["f primo (x)", "f prime (x)"]);
  });

  it("keeps the grouping of a fraction and a root in brackets", () => {
    expect(both("\\frac{a+b}{2}")).toEqual(["(a più b) fratto 2", "(a plus b) over 2"]);
    expect(both("\\frac{1}{2}mv^{2}")).toEqual(["(1 fratto 2) m v al quadrato", "(1 over 2) m v squared"]);
    expect(both("\\sqrt{x^{2}+1}")).toEqual(["radice quadrata di (x al quadrato più 1)", "square root of (x squared plus 1)"]);
    expect(both("\\sqrt[3]{x}")).toEqual(["radice cubica di x", "cube root of x"]);
    expect(both("\\left(a+b\\right)^{2}")).toEqual(["(a più b) al quadrato", "(a plus b) squared"]);
    expect(both("\\left(\\frac{a}{b}\\right)^{n}")).toEqual(["(a fratto b) alla n", "(a over b) to the n"]);
  });

  it("reads functions, limits, sums and derivatives", () => {
    expect(both("\\sin^{2}\\left(x\\right)+\\cos^{2}\\left(x\\right)=1")).toEqual([
      "seno al quadrato di x più coseno al quadrato di x uguale a 1",
      "sine squared of x plus cosine squared of x equals 1",
    ]);
    expect(both("\\lim_{x\\to 0}\\frac{\\sin\\left(x\\right)}{x}")).toEqual([
      "limite per x che tende a 0 di (seno di x) fratto x",
      "limit as x approaches 0 of (sine of x) over x",
    ]);
    expect(both("\\sum_{i=1}^{n}i^{2}")).toEqual([
      "sommatoria da i uguale a 1 a n di i al quadrato",
      "sum from i equals 1 to n of i squared",
    ]);
    expect(both("\\frac{\\mathrm{d}}{\\mathrm{d}x}x^{2}=2x")).toEqual([
      "derivata rispetto a x di x al quadrato uguale a 2x",
      "derivative with respect to x of x squared equals 2x",
    ]);
    expect(both("\\log_{2}\\left(8\\right)")).toEqual(["logaritmo in base 2 di 8", "log base 2 of 8"]);
    expect(both("\\left|x-1\\right|")).toEqual(["valore assoluto di (x meno 1)", "absolute value of (x minus 1)"]);
  });

  it("keeps the brackets of an interval and of a set, and what belongs to an exponent", () => {
    expect(both("x\\in\\left[2,+\\infty\\right)")).toEqual(["x appartiene a [2, più infinito)", "x in [2, plus infinity)"]);
    expect(both("x \\in (-\\infty, 2]")).toEqual(["x appartiene a (meno infinito, 2]", "x in (minus infinity, 2]"]);
    expect(both("\\left\\{a,b\\right\\}")).toEqual(["{a, b}", "{a, b}"]);
    expect(both("x^{2^{n}}")).toEqual(["x alla (2 alla n)", "x to the (2 to the n)"]);
    expect(both("3{,}5\\differentialD x")).toEqual(["3,5 in dx", "3,5 dx"]);
  });

  it("keeps Greek letters and other signs as they are written", () => {
    expect(both("\\omega=2\\pi f")).toEqual(["ω uguale a 2πf", "ω equals 2πf"]);
    expect(both("\\vec{F}=m\\vec{a}")).toEqual(["vettore F uguale a m vettore a", "vector F equals m vector a"]);
  });

  it("gives nothing for a formula it cannot read, instead of a wrong reading", () => {
    expect(formulaWords("\\begin{matrix}1&2\\end{matrix}", "it")).toBeNull();
    expect(formulaWords("\\frac{a}{", "it")).toBeNull();
    expect(formulaWords("\\frac{}{2}", "it")).toBeNull();
    expect(formulaWords("  ", "it")).toBeNull();
  });
});

describe("answerReading", () => {
  it("reads the formulas in an answer and leaves its words as they are", () => {
    expect(answerReading("La legge è $x(t)=t^{3}-t^{2}+1$ metri", "it")).toBe(
      "La legge è x(t) uguale a t al cubo meno t al quadrato più 1 metri",
    );
    expect(answerReading("$v=\\frac{s}{t}$", "en")).toBe("v equals s over t");
  });

  it("is null when the answer reads as it is typed", () => {
    expect(answerReading("È lo spostamento diviso il tempo.", "it")).toBeNull();
    expect(answerReading("Costa 5\\$ in tutto", "it")).toBeNull();
    expect(answerReading("", "it")).toBeNull();
  });

  it("is null when one of the formulas cannot be read", () => {
    expect(answerReading("$x^{2}$ e $\\begin{matrix}1\\end{matrix}$", "it")).toBeNull();
  });
});
