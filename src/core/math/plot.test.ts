import { describe, expect, it } from "vitest";
import { compileExpr, evalExpr, splitSeries } from "./plot";

/** Points of the curve at n + 1 even steps, without the ones that are not finite. */
function sample(
  source: string,
  a: number,
  b: number,
  n = 240,
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i += 1) {
    const x = a + ((b - a) * i) / n;
    const y = evalExpr(source, x);
    if (Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

describe("plot", () => {
  it("evaluates sin(x)/x", () => {
    expect(evalExpr("sin(x)/x", 1)).toBeCloseTo(Math.sin(1), 6);
    expect(evalExpr("-x^2", 3)).toBe(-9);
    expect(evalExpr("2^3^2", 0)).toBe(512);
    expect(evalExpr("2^-3", 0)).toBeCloseTo(0.125);
    expect(evalExpr("x^-2", 2)).toBeCloseTo(0.25);
    const curve = sample("sin(x)/x", -8, 8);
    expect(curve.length).toBeGreaterThan(100);
    expect(curve.some((point) => Math.abs(point.x) < 0.1 && Math.abs(point.y) > 0.9)).toBe(true);
  });

  it("parses once and evaluates at any x, and refuses what evalExpr refuses", () => {
    const curve = compileExpr("2*sin(x)+x^2");
    for (const x of [-2, 0, 0.5, 3]) expect(curve(x)).toBe(evalExpr("2*sin(x)+x^2", x));
    expect(() => compileExpr("foo(x)")).toThrow("expr-fn");
    expect(() => compileExpr("constructor(x)")).toThrow("expr-fn");
    expect(() => compileExpr("sin(x")).toThrow("expr-end");
    expect(() => compileExpr("x x")).toThrow("expr-tail");
  });

  it("keeps a steep curve in one stroke and breaks a pole", () => {
    const at = compileExpr;
    expect(splitSeries(sample("x^3", -8, 8), at("x^3"))).toHaveLength(1);
    expect(splitSeries(sample("1/(1+1000000000000*x^2)", -8, 8), at("1/(1+1000000000000*x^2)"))).toHaveLength(1);
    expect(splitSeries(sample("sin(x)", -8, 8), at("sin(x)"))).toHaveLength(1);
    expect(splitSeries(sample("sin(2000*x)", -8, 8), at("sin(2000*x)"))).toHaveLength(1);
    expect(splitSeries(sample("sin(47.12389*x)", -8, 8), at("sin(47.12389*x)"))).toHaveLength(1);
    expect(splitSeries(sample("1000000000*sin(2000*x)", -8, 8), at("1000000000*sin(2000*x)"))).toHaveLength(1);
    expect(splitSeries(sample("0.00001/(x-0.06666)", -8, 8), at("0.00001/(x-0.06666)")).length).toBeGreaterThan(1);
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
    expect(splitSeries(sample("1/(x-0.001)", -8, 8), at("1/(x-0.001)")).length).toBeGreaterThan(1);
    const cubic = "1000000000000*(x-0.02500025)*(x-0.02500125)*(x-0.02500225)";
    expect(splitSeries(sample(cubic, -8, 8), at(cubic))).toHaveLength(1);
  });
});
