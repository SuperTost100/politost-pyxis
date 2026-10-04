import { expect, it } from "vitest";
import { analyzeGraph, graphExpression } from "./graph-analysis";
it("normalizes plain and nested LaTeX scalar input without accepting executable syntax", () => {
  expect(graphExpression("\\frac{\\sin(x)}{x}")).toBe("((sin(x))/(x))");
  expect(graphExpression("2x^2 + \\sqrt{x}")).toBe("2*x^2+sqrt(x)");
  expect(graphExpression("\\frac{1}{\\frac{x}{2}}")).toBe("((1)/(((x)/(2))))");
  expect(() => graphExpression("__import__('os')")).toThrow();
  expect(() => graphExpression("x; alert(1)")).toThrow();
});
it("builds derivatives and a cumulative Simpson integral from a chosen lower bound", () => {
  const g = analyzeGraph("x^2", [-2, 2], 1);
  expect(g.d1.flat().find((p) => p.x === 2)?.y).toBeCloseTo(4, 4);
  expect(g.d2.flat().find((p) => p.x === 2)?.y).toBeCloseTo(2, 3);
  expect(g.integral.flat().find((p) => p.x === 2)?.y).toBeCloseTo(7 / 3, 5);
  expect(g.integral.flat().find((p) => p.x === -2)?.y).toBeCloseTo(-3, 5);
});
it("integrates removable holes but refuses an integral anchored on a pole", () => {
  const hole = analyzeGraph("sin(x)/x", [-2, 2], 0);
  expect(hole.at(0)).toBeCloseTo(1, 6);
  expect(hole.integral.flat().at(-1)?.y).toBeCloseTo(1.6054, 3);
  expect(analyzeGraph("1/x", [-2, 2], 0).integral).toEqual([]);
  const pole = analyzeGraph("1/(x-0.03)", [-2, 2], 1);
  expect(pole.f.length).toBeGreaterThan(1);
  expect(pole.integral.flat().every((p) => p.x > 0.03)).toBe(true);
});
