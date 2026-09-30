import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./normalizeMathDelimiters";

describe("normalizeMathDelimiters", () => {
  it("converts inline \\( \\) to dollar math", () => {
    expect(normalizeMathDelimiters("a \\(x^2\\) b")).toBe("a $x^2$ b");
  });

  it("converts display \\[ \\] to double-dollar math", () => {
    expect(normalizeMathDelimiters("before\\[\\sum_i x_i\\]after")).toBe(
      "before$$\\sum_i x_i$$after",
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
    expect(out).toContain("$$\\int_0^1 t\\,dt$$");
    expect(out).toContain("Inline dollar $x$");
    expect(out).toContain("Display dollar $$y$$");
  });
});
