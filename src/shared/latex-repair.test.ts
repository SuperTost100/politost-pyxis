import { describe, expect, it } from "vitest";
import { repairLatexEscapes, repairModelStrings } from "./latex-repair";

// In these strings "\v", "\t", "\f", "\b", "\r" and "\n" are the control characters a model's single backslash became.
describe("repairLatexEscapes", () => {
  it("restores the commands a single backslash in JSON turned into control characters", () => {
    expect(repairLatexEscapes("$m\vec{g}\\sin\theta + \frac{a}{b} + \beta$")).toBe(
      "$m\\vec{g}\\sin\\theta + \\frac{a}{b} + \\beta$",
    );
  });

  it("restores \\right and \\times", () => {
    expect(repairLatexEscapes("$\\left(x\right) \times 2$")).toBe("$\\left(x\\right) \\times 2$");
  });

  it("restores \\nu and \\neq inside math but keeps a real line break before text", () => {
    expect(repairLatexEscapes("$a\neq b$ e $\nu$")).toBe("$a\\neq b$ e $\\nu$");
    expect(repairLatexEscapes("Prima riga.\nnuova riga, poi $x$.")).toBe("Prima riga.\nnuova riga, poi $x$.");
    expect(repairLatexEscapes("Riga uno\nnot a formula")).toBe("Riga uno\nnot a formula");
  });

  it("keeps real tabs, newlines and Windows line ends", () => {
    const text = "a\tb\nc\r\nd\n\ttext";
    expect(repairLatexEscapes(text)).toBe(text);
  });

  it("leaves a correct string alone", () => {
    const text = "$\\frac{1}{2}\\theta$ e \\(x\\)";
    expect(repairLatexEscapes(text)).toBe(text);
  });
});

describe("repairModelStrings", () => {
  it("repairs every string in a nested value and keeps the rest", () => {
    expect(
      repairModelStrings({ stem: "$\theta$", options: ["$\frac{1}{2}$", "x"], n: 3, ok: true, none: null }),
    ).toEqual({ stem: "$\\theta$", options: ["$\\frac{1}{2}$", "x"], n: 3, ok: true, none: null });
  });
});
