import { expect, it } from "vitest";
import { analyzeGraph, graphExpression } from "./graph-analysis";
import { evalExpr } from "./plot";
it("normalizes plain and nested LaTeX scalar input without accepting executable syntax", () => {
  expect(graphExpression("\\frac{\\sin(x)}{x}")).toBe("((sin(x))/(x))");
  expect(graphExpression("2x^2 + \\sqrt{x}")).toBe("2*x^2+sqrt(x)");
  expect(graphExpression("(x+1)sin(x)")).toBe("(x+1)*sin(x)");
  expect(graphExpression("2e")).toBe("2*e");
  expect(graphExpression("2e-3")).toBe("2e-3");
  expect(graphExpression("2e3")).toBe("2e3");
  expect(evalExpr(graphExpression("2e-3"), 0)).toBe(0.002);
  expect(evalExpr(graphExpression("2e"), 0)).toBeCloseTo(2 * Math.E);
  expect(graphExpression("\\frac{1}{\\frac{x}{2}}")).toBe("((1)/(((x)/(2))))");
  expect(() => graphExpression("__import__('os')")).toThrow();
  expect(() => graphExpression("x; alert(1)")).toThrow();
});
it("evaluates common textbook products, function notation and absolute values", () => {
  const x = -0.7;
  for (const [input, expected] of [
    ["x\\sin(x)", x * Math.sin(x)],
    ["2x\\cos(x)", 2 * x * Math.cos(x)],
    ["\\pi x", Math.PI * x],
    ["x\\pi", x * Math.PI],
    ["\\sin x", Math.sin(x)],
    ["\\sin^2(x)", Math.sin(x) ** 2],
    ["|x|", Math.abs(x)],
    ["2|x|", 2 * Math.abs(x)],
  ] as const) expect(evalExpr(graphExpression(input), x)).toBeCloseTo(expected, 10);
  expect(() => graphExpression("|x")).toThrow();
  expect(() => graphExpression("sine(x)")).toThrow();
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
it("reads ln, the Italian sen, π and a decimal comma", () => {
  const x = 0.8;
  for (const [input, expected] of [
    ["ln(x)", Math.log(x)],
    ["2ln(x)", 2 * Math.log(x)],
    ["x ln x", x * Math.log(x)],
    ["sen(x)", Math.sin(x)],
    ["sen^2(x)", Math.sin(x) ** 2],
    ["xsen(x)", x * Math.sin(x)],
    ["2xln(x)", 2 * x * Math.log(x)],
    ["π", Math.PI],
    ["2πx", 2 * Math.PI * x],
    ["sen(πx)", Math.sin(Math.PI * x)],
    ["sinπ", Math.sin(Math.PI)],
    ["0,5x", 0.5 * x],
    ["x^2 + 1,25", x ** 2 + 1.25],
    ["0{,}5x", 0.5 * x],
  ] as const) expect(evalExpr(graphExpression(input), x)).toBeCloseTo(expected, 10);
  expect(graphExpression("ln(x)")).toBe("log(x)");
  expect(graphExpression("0,5")).toBe("0.5");
  // A comma that is not between two digits is not a decimal point, and the grammar has no argument lists.
  expect(() => graphExpression("log(x, 2)")).toThrow();
  expect(() => graphExpression("1, 5")).toThrow();
  expect(() => graphExpression("lnx2")).toThrow();
  expect(() => graphExpression("send(x)")).toThrow();
  expect(() => graphExpression("asen(x)")).toThrow();
});
