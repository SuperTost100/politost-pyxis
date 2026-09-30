import { describe, expect, it } from "vitest";
import { derivative, evalExpr, sample, secondDerivative, simpson, splitSeries } from "./plot";

describe("plot", () => {
  it("evaluates sin(x)/x and its derivatives", () => {
    expect(evalExpr("sin(x)/x", 1)).toBeCloseTo(Math.sin(1), 6);
    expect(evalExpr("-x^2", 3)).toBe(-9);
    expect(evalExpr("2^3^2", 0)).toBe(512);
    expect(evalExpr("2^-3", 0)).toBeCloseTo(0.125);
    expect(evalExpr("x^-2", 2)).toBeCloseTo(0.25);
    expect(derivative("x^2", 3)).toBeCloseTo(6, 3);
    expect(secondDerivative("x^2", 3)).toBeCloseTo(2, 2);
    const curve = sample("sin(x)/x", -8, 8);
    expect(curve.length).toBeGreaterThan(100);
    expect(curve.some((point) => Math.abs(point.x) < 0.1 && Math.abs(point.y) > 0.9)).toBe(true);
  });

  it("keeps a steep curve in one stroke and breaks a pole", () => {
    const at = (source: string) => (x: number) => evalExpr(source, x);
    expect(splitSeries(sample("x^3", -8, 8), at("x^3"))).toHaveLength(1);
    expect(splitSeries(sample("1/(1+1000000000000*x^2)", -8, 8), at("1/(1+1000000000000*x^2)"))).toHaveLength(1);
    expect(splitSeries(sample("sin(x)", -8, 8), at("sin(x)"))).toHaveLength(1);
    expect(splitSeries(sample("sin(2000*x)", -8, 8), at("sin(2000*x)"))).toHaveLength(1);
    expect(splitSeries(sample("sin(47.12389*x)", -8, 8), at("sin(47.12389*x)"))).toHaveLength(1);
    expect(splitSeries(sample("1/(x-0.00000001)", -8, 8), at("1/(x-0.00000001)")).length).toBeGreaterThan(1);
    expect(splitSeries(sample("0.000001/(x-0.025)", -8, 8), at("0.000001/(x-0.025)")).length).toBeGreaterThan(1);
    expect(splitSeries(sample("x+exp(-1000*x^2)", -8, 8), at("x+exp(-1000*x^2)"))).toHaveLength(1);
    expect(
      splitSeries(
        sample("100*exp(-10000*(x-0.0333333333333333)^2)", -8, 8),
        at("100*exp(-10000*(x-0.0333333333333333)^2)"),
      ),
    ).toHaveLength(1);
    expect(splitSeries(sample("1/(x-0.02)", -8, 8), at("1/(x-0.02)")).length).toBeGreaterThan(1);
    expect(splitSeries(sample("0.001/(x-0.03)", -8, 8), at("0.001/(x-0.03)")).length).toBeGreaterThan(1);
    expect(splitSeries(sample("1/x", -2, 2), at("1/x")).length).toBeGreaterThan(1);
    expect(splitSeries(sample("tan(x)", -8, 8), at("tan(x)")).length).toBeGreaterThan(1);
    expect(splitSeries(sample("1/(x-0.03)^2", -8, 8), at("1/(x-0.03)^2")).length).toBeGreaterThan(1);
  });

  it("integrates sin(x) from 0 to pi", () => {
    expect(simpson("sin(x)", 0, Math.PI)).toBeCloseTo(2, 3);
  });
});
