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
});
