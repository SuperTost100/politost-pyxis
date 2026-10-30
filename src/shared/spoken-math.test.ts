import { describe, expect, it } from "vitest";
import { plainTitle, spokenText } from "./spoken-math";

describe("spokenText", () => {
  it("drops the dollar signs and the units markup", () => {
    expect(spokenText("$6\\ \\text{m/s}$")).toBe("6 m/s");
    expect(spokenText("$10\\,\\mathrm{kg}$")).toBe("10 kg");
  });

  it("writes common symbols and commands as signs", () => {
    expect(spokenText("$m\\vec{g}\\sin\\theta$")).toBe("mg sin θ");
    expect(spokenText("$\\frac{a}{b}$ e $x^{2}$ e $\\sqrt{x}$")).toBe("a/b e x^2 e √x");
    expect(spokenText("$F \\cdot d \\times t \\leq 3$")).toBe("F · d × t ≤ 3");
  });

  it("keeps ordinary text, and reads display math too", () => {
    expect(spokenText("Il valore è $$E = mc^2$$ joule")).toBe("Il valore è E = mc^2 joule");
  });

  it("reads a formula whose backslashes were lost to control characters as the student sees it", () => {
    expect(spokenText("$m\vec{g}\\sin\theta + \frac{a}{b}$")).toBe("mg sin θ + a/b");
  });

  it("reads an accent or a root on a single token without braces, as the same formula with braces", () => {
    expect(spokenText("$A = |\\vec\\omega| u$")).toBe("A = | ω | u");
    expect(spokenText("$\\hat u_x$ e $\\frac12$ e $\\sqrt5$")).toBe("u_x e 1/2 e √5");
    expect(spokenText("$\\textbf{b}$ e $\\dots x$")).toBe("b e … x");
  });

  it("does not glue a command to the accented letter after it, or leave a space before an index", () => {
    expect(spokenText("$\\vec a\\cdot\\vec b$")).toBe("a · b");
    expect(spokenText("$\\vec{a}\\cdot\\vec{b}$")).toBe("a · b");
    expect(spokenText("$\\sigma_x$ e $\\bar{x}$")).toBe("σ_x e x");
    expect(spokenText("$A\\,m\\ldots ^3$")).toBe("A m …^3");
  });

  it("leaves no backslash or brace behind", () => {
    expect(spokenText("$\\operatorname{rot}\\mathbf{B}_{\\perp}$")).not.toMatch(/[\\{}]/);
  });
});

describe("plainTitle", () => {
  it("writes the formulas of a selection as readable text, once, with no dollar signs", () => {
    expect(plainTitle("dove $\\bar{x}$ è il valore, $\\sigma_x$ l'incertezza e $[X]$ l'unità")).toBe(
      "dove x̄ è il valore, σₓ l'incertezza e [X] l'unità",
    );
    expect(plainTitle("la velocità $v^2$ e $a_{12}$ e $x_{q}$")).toBe("la velocità v² e a₁₂ e x_q");
  });

  it("cuts at a word and drops a formula the caller cut in half", () => {
    expect(plainTitle("dove $\\bar{x}$ è il valore numerico, $\\sigma_x$ è l'incertezza e $[X]$ è l'unità di misura", 40)).toBe(
      "dove x̄ è il valore numerico, σₓ è…",
    );
    expect(plainTitle("dove $\\bar{x}$ vale e poi $\\sigma_{")).toBe("dove x̄ vale e poi");
  });

  it("keeps a price and plain text as they are", () => {
    expect(plainTitle("Costa $5 e poi $6.50 in tutto")).toBe("Costa $5 e poi $6.50 in tutto");
  });
});
