import { describe, expect, it } from "vitest";
import { clozeAnswer, clozeQuestion, isCloze } from "./cloze";

describe("cloze", () => {
  const text = "La {{c1::mitocondria::organello}} produce {{c2::ATP}}.";
  it("detects deletions only in cloze markup", () => {
    expect(isCloze(text)).toBe(true);
    expect(isCloze("Cos'è la mitocondria?")).toBe(false);
    expect(isCloze("{{1}} non è un cloze")).toBe(false);
  });
  it("hides answers, keeping hints, then reveals them", () => {
    expect(clozeQuestion(text)).toBe("La **(organello)** produce **(…)**.");
    expect(clozeAnswer(text)).toBe("La **mitocondria** produce **ATP**.");
  });
  it("supports TeX inside a deletion", () => {
    expect(clozeAnswer("{{c1::$x^2$}}")).toBe("**$x^2$**");
  });
  it("keeps a deletion inside a formula a formula: a box, never ** around TeX", () => {
    const front = "$\\mathbb{Q} \\subset {{c1::\\mathbb{R}}} \\subset {{c2::\\mathbb{C}::campo}}$ e {{c3::ATP}}";
    expect(clozeAnswer(front)).toBe(
      "$\\mathbb{Q} \\subset \\boxed{\\mathbb{R}} \\subset \\boxed{\\mathbb{C}}$ e **ATP**",
    );
    expect(clozeQuestion(front)).toBe(
      "$\\mathbb{Q} \\subset \\boxed{\\ldots} \\subset \\boxed{\\text{campo}}$ e **(…)**",
    );
  });
  it("ends a deletion at the }} that closes its own braces", () => {
    expect(isCloze("{{c1::\\mathbb{R}}}")).toBe(true);
    expect(clozeAnswer("$x \\in {{c1::\\frac{1}{2}}}$ e {{c2::\\{a\\}::insieme}}")).toBe(
      "$x \\in \\boxed{\\frac{1}{2}}$ e **\\{a\\}**",
    );
    expect(clozeAnswer("{{c1::aperto")).toBe("{{c1::aperto");
  });
});
