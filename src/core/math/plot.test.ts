import { describe, expect, it } from "vitest";
import { derivative, evalExpr, sample, secondDerivative, simpson } from "./plot";

describe("plot", () => {
  it("evaluates sin(x)/x and its derivatives", () => {
    expect(evalExpr("sin(x)/x", 1)).toBeCloseTo(Math.sin(1), 6);
    expect(derivative("x^2", 3)).toBeCloseTo(6, 3);
    expect(secondDerivative("x^2", 3)).toBeCloseTo(2, 2);
    const curve = sample("sin(x)/x", -8, 8);
    expect(curve.length).toBeGreaterThan(100);
    expect(curve.some((point) => Math.abs(point.x) < 0.1 && Math.abs(point.y) > 0.9)).toBe(true);
  });

  it("integrates sin(x) from 0 to pi", () => {
    expect(simpson("sin(x)", 0, Math.PI)).toBeCloseTo(2, 3);
  });
});
