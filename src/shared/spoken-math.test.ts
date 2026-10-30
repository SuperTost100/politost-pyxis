import { describe, expect, it } from "vitest";
import { spokenText } from "./spoken-math";

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

  it("leaves no backslash or brace behind", () => {
    expect(spokenText("$\\operatorname{rot}\\mathbf{B}_{\\perp}$")).not.toMatch(/[\\{}]/);
  });
});
