import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

// Runs the real symbolic.py in the pinned local Pyodide (.tmp/pyodide), as the sandbox does.
const pack = join(process.cwd(), ".tmp/pyodide");
const available = existsSync(join(pack, "pyodide.js"));
type Check = { state: string; reason?: string };
let check: (claim: Record<string, unknown>) => Check;
type Report = {
  final: { state: string; reason?: string; numbers?: [number, number] };
  steps: number;
  firstWrong?: { index: number; previous: string; step: string };
};
let grade: (answer: string, reference: string) => Report;

describe.skipIf(!available)("sandbox symbolic checks", () => {
  beforeAll(async () => {
    (globalThis as { require?: NodeJS.Require }).require = createRequire(
      import.meta.url,
    );
    vm.runInThisContext(readFileSync(join(pack, "pyodide.js"), "utf8"), {
      filename: "pyodide.js",
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const python = await (
      globalThis as unknown as {
        loadPyodide: (options: { indexURL: string }) => Promise<{
          loadPackage: (names: string[]) => Promise<void>;
          runPython: (code: string) => string;
          globals: { set: (name: string, value: string) => void };
        }>;
      }
    ).loadPyodide({ indexURL: pack + "/" });
    await python.loadPackage(["sympy", "mpmath"]);
    python.runPython(readFileSync("src/sandbox/symbolic.py", "utf8"));
    check = (claim) => {
      python.globals.set("_claim", JSON.stringify(claim));
      return JSON.parse(python.runPython("check_claim(_claim)")) as Check;
    };
    grade = (answer, reference) => {
      python.globals.set("_claim", JSON.stringify({ answer, reference }));
      return JSON.parse(python.runPython("check_grade(_claim)")) as Report;
    };
  }, 90000);
  const solve = (expr: string, claimed: string) =>
    check({ kind: "solve", expr, claimed, vars: ["x"] });

  it("does not verify a root list that omits real roots", () => {
    expect(solve("x**2-1", "1")).toEqual({
      state: "failed",
      reason: "incomplete-solution-set",
    });
    expect(solve("x**3-x", "[0, 1]").state).toBe("failed");
    expect(solve("x**2-2", "sqrt(2)").state).toBe("failed");
    expect(solve("(x**2-1)/(x-1)", "[-1, 1]").state).toBe("failed");
  });
  it("verifies the complete real solution set, with order and duplicates ignored", () => {
    const done = { state: "verified", reason: "real-solution-set" };
    expect(solve("x**2-1", "[-1, 1]")).toEqual(done);
    expect(solve("x**2-1", "1, -1")).toEqual(done);
    expect(solve("x**2-1", "[1, 1, -1]")).toEqual(done);
    expect(solve("x**2-1", "[1.0, -1]")).toEqual(done);
    expect(solve("x**2-2*x+1", "1")).toEqual(done);
    expect(solve("x**2-2", "[sqrt(2), -sqrt(2)]")).toEqual(done);
    expect(solve("(x**2-1)/(x-1)", "-1")).toEqual(done);
  });
  it("fails extraneous roots and non-roots", () => {
    expect(solve("x**2-1", "[-1, 1, 2]")).toMatchObject({ state: "failed" });
    expect(solve("x**2-1", "[1, 2]")).toMatchObject({ state: "failed" });
    expect(solve("x**2+1", "1")).toMatchObject({ state: "failed" });
    expect(solve("exp(x)", "0")).toMatchObject({ state: "failed" });
  });
  it("stays unchecked when completeness cannot be decided", () => {
    expect(solve("sin(x)", "0")).toEqual({
      state: "none",
      reason: "completeness-unresolved",
    });
    expect(solve("x**2+1", "[I, -I]")).toEqual({
      state: "none",
      reason: "unsupported-complex-roots",
    });
    expect(solve("x-x", "0").state).toBe("none");
    expect(solve("x**2-1", "1/0").state).not.toBe("verified");
    expect(solve("x**2-1", "[]").state).toBe("none");
    expect(solve("x**2-1", "__import__('os')").state).toBe("none");
    expect(
      check({ kind: "solve", expr: "x*y", claimed: "0", vars: ["x", "y"] })
        .state,
    ).toBe("none");
  });
  it("keeps the symbolic and numeric checks for the other kinds", () => {
    const base = { expr: "x**2*sin(x)", vars: ["x"] };
    expect(
      check({
        kind: "derivative",
        ...base,
        claimed: "2*x*sin(x)+x**2*cos(x)",
      }),
    ).toEqual({ state: "verified", reason: "symbolic" });
    expect(check({ kind: "derivative", ...base, claimed: "x" }).state).toBe(
      "failed",
    );
    expect(
      check({ kind: "equal", expr: "sin(x)**2+cos(x)**2", claimed: "1" }).state,
    ).toBe("verified");
    expect(
      check({ kind: "integral", expr: "2*x", claimed: "x**2" }).state,
    ).toBe("verified");
  });
  it("accepts the derivative example in the checks prompt", () => {
    const prompt = readFileSync("resources/prompts/chat.checks.md", "utf8");
    const example = /expr="([^"]+)", claimed="([^"]+)"/.exec(prompt);
    expect(example).not.toBeNull();
    expect(prompt).not.toContain("\\*");
    expect(
      check({
        kind: "derivative",
        expr: example![1]!,
        claimed: example![2]!,
        vars: ["x"],
      }).state,
    ).toBe("verified");
  });

  // Grading: the student's final answer against the reference, then each step of the work against the one before.
  const final = (answer: string, reference: string) =>
    grade(answer, reference).final.state;

  it("matches equivalent final expressions in student notation", () => {
    expect(final("1/2", "0.5")).toBe("verified");
    expect(final("2x+2", "2(x+1)")).toBe("verified");
    expect(final("\\frac{\\sqrt{2}}{2}", "1/sqrt(2)")).toBe("verified");
    expect(final("x/(x+1)", "1 - 1/(x+1)")).toBe("verified");
    expect(final("sen(x)", "\\sin x")).toBe("verified");
    expect(final("e^x", "exp(x)")).toBe("verified");
    expect(final("2x cos(x²)", "La derivata è 2x\\cos(x^2)")).toBe("verified");
    expect(final("2x+3", "2(x+1)")).toBe("failed");
  });
  it("leaves numeric tolerance to core by returning both values", () => {
    expect(grade("0,333", "1/3").final).toEqual({
      state: "failed",
      reason: "expression",
      numbers: [0.333, 1 / 3],
    });
    expect(grade("1860", "1848").final.numbers).toEqual([1860, 1848]);
    expect(grade("x = 1,41", "x = sqrt(2)").final.numbers).toEqual([
      1.41,
      Math.SQRT2,
    ]);
  });
  it("compares equations and solution sets written in different ways", () => {
    expect(final("x = 3", "3")).toBe("verified");
    expect(final("x = 2 oppure x = -2", "x = ±2")).toBe("verified");
    expect(final("x_1 = 2, x_2 = -2", "{-2, 2}")).toBe("verified");
    expect(final("x(x+1) = 0\nx = 0 or x = -1", "x = 0, x = -1")).toBe(
      "verified",
    );
    expect(final("y = 2x + 1", "2x - y + 1 = 0")).toBe("verified");
    expect(final("E = m c^2", "E = mc^2")).toBe("verified");
    expect(final("x = 2", "x = ±2")).toBe("failed");
    expect(final("y = 2x + 3", "y = 2x + 1")).toBe("failed");
  });
  it("compares intervals and inequalities", () => {
    expect(final("1 < x ≤ 3", "(1, 3]")).toBe("verified");
    expect(final("x ∈ [1; 3)", "[1, 3)")).toBe("verified");
    expect(final("]1, 3[", "(1,3)")).toBe("verified");
    expect(final("x ≥ 2", "[2, +∞)")).toBe("verified");
    expect(final("x < -1 or x > 1", "(-∞, -1) ∪ (1, +∞)")).toBe("verified");
    expect(final("x > 2", "x >= 2")).toBe("failed");
  });
  it("stays unchecked on prose, units, rounding and domain questions", () => {
    expect(final("The answer is that energy is conserved", "Energy is conserved")).toBe("none");
    expect(final("x = 2 (accettabile)", "x = 2")).toBe("none");
    expect(final("5 m/s", "5")).toBe("none");
    expect(final("x = ±1.41", "x = ±sqrt(2)")).toBe("none");
    expect(final("log(x*y)", "log(x)+log(y)")).toBe("none");
    expect(final("Verifica: 2·2 + 3 = 7", "x = 2")).toBe("none");
    expect(final("__import__('os')", "1")).toBe("none");
  });
  it("names the first step that does not follow from the one before", () => {
    expect(grade("2x + 3 = 7\n2x = 10\nx = 5", "x = 2")).toMatchObject({
      steps: 3,
      firstWrong: { index: 2, previous: "2x + 3 = 7", step: "2x = 10" },
    });
    expect(grade("x^2 = 4\nx = 2", "x = ±2").firstWrong).toMatchObject({
      index: 2,
    });
    expect(grade("-2x > 4\nx > -2", "x < -2").firstWrong).toMatchObject({
      step: "x > -2",
    });
    expect(
      grade("f(x) = (x+1)^2\n= x^2 + 2x + 1\n= x^2 + 1", "x^2+2x+1").firstWrong,
    ).toMatchObject({ index: 3, step: "= x^2 + 1" });
    // A chain that disagrees with itself on one line.
    expect(grade("f(2) = 3·4 + 1 = 12", "13").firstWrong).toMatchObject({
      index: 1,
    });
  });
  it("does not blame correct work", () => {
    const clean = (answer: string, reference: string) =>
      grade(answer, reference).firstWrong;
    expect(clean("2x + 3 = 7\n2x = 4\nx = 2", "x = 2")).toBeUndefined();
    // Squaring adds x = 1; dropping it is not a lost solution.
    expect(
      clean("√x = x - 2\nx = (x-2)^2\nx^2 - 5x + 4 = 0\nx = 1 o x = 4\nx = 4", "x = 4"),
    ).toBeUndefined();
    // A function and its derivative on separate lines, a substitution, and a system.
    expect(clean("x^3 + 2x\n3x^2 + 2", "3x^2+2")).toBeUndefined();
    expect(clean("v = s/t = 100/20 = 5 m/s", "5 m/s")).toBeUndefined();
    expect(clean("x = y = 0", "0")).toBeUndefined();
    expect(clean("2x + y = 5\nx - y = 1\n3x = 6\nx = 2\ny = 1", "y = 1")).toBeUndefined();
    expect(
      clean("Applico la regola della catena.\nf'(x) = 2x·cos(x²)\nf'(x) = 2x cos(x^2)", "2x cos(x^2)"),
    ).toBeUndefined();
    expect(
      clean("\\[ x^{2} - 4 = 0 \\Rightarrow x = \\pm 2 \\]", "x=\\pm2"),
    ).toBeUndefined();
  });
});
