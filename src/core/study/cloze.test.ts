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
});
