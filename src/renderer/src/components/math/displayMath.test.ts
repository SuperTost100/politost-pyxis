import { describe, expect, it } from "vitest";
import { parseDisplayMath } from "./displayMath";
import type { MathSegment } from "./mathString";

const text = (t: string): MathSegment => ({ kind: "text", text: t });
const math = (latex: string, display?: boolean): MathSegment =>
  display ? { kind: "math", latex, display } : { kind: "math", latex };

describe("parseDisplayMath", () => {
  it("keeps standard dollar delimiters and LaTeX paren/bracket delimiters", () => {
    expect(parseDisplayMath("La risposta è $x^{2}+1$.")).toEqual([
      text("La risposta è "),
      math("x^{2}+1"),
      text("."),
    ]);
    expect(parseDisplayMath("Vedi \\(x^{2}+1\\) e \\[\\frac{1}{2}\\].")).toEqual([
      text("Vedi "),
      math("x^{2}+1"),
      text(" e "),
      math("\\frac{1}{2}", true),
      text("."),
    ]);
  });

  it("draws standalone and inline bare LaTeX formulas from student answers and steps", () => {
    expect(parseDisplayMath("x^{2}+1")).toEqual([math("x^{2}+1")]);
    expect(parseDisplayMath("y = x^{2} + 1")).toEqual([math("y = x^{2} + 1")]);
    expect(parseDisplayMath("\\frac{1}{2}x^{2} + C")).toEqual([math("\\frac{1}{2}x^{2} + C")]);
    expect(
      parseDisplayMath("Passo 2: applico il fattore integrante e confronto con x^{2}+1."),
    ).toEqual([
      text("Passo 2: applico il fattore integrante e confronto con "),
      math("x^{2}+1"),
      text("."),
    ]);
    expect(parseDisplayMath("Confronto x^{2}+1 e y^{2}-1.")).toEqual([
      text("Confronto "),
      math("x^{2}+1"),
      text(" e "),
      math("y^{2}-1"),
      text("."),
    ]);
    expect(parseDisplayMath("Sostituisco \\alpha = 0 e ottengo e^{-x^{2}}.")).toEqual([
      text("Sostituisco "),
      math("\\alpha = 0"),
      text(" e ottengo "),
      math("e^{-x^{2}}"),
      text("."),
    ]);
    expect(parseDisplayMath("La successione a_{n+1} = 2a_{n} + 1 converge.")).toEqual([
      text("La successione "),
      math("a_{n+1} = 2a_{n} + 1"),
      text(" converge."),
    ]);
  });

  it("keeps plain text, units, prices, snake_case, paths and URLs plain", () => {
    for (const plain of [
      "La soluzione esiste ed è unica.",
      "Passo 1: verifico le ipotesi del teorema di Cauchy.",
      "14,7 m",
      "24 km/h",
      "costa 5$ o 6$",
      "snake_case_var e foo_bar",
      "C:\\Users\\tost\\file.txt",
      "Vedi https://example.com/a^2/b_1 per i dettagli.",
    ]) {
      expect(parseDisplayMath(plain), plain).toEqual([text(plain)]);
    }
    expect(parseDisplayMath("escaped \\$5")).toEqual([text("escaped $5")]);
  });
});
