import { beforeEach, describe, expect, it, vi } from "vitest";

// Main charges every report to a limit of 20 a minute that all errors share, and drops a repeated one only afterwards.
describe("noteFormulaFailure", () => {
  let note: typeof import("./formulaFailure").noteFormulaFailure;
  let count: typeof import("./formulaFailure").formulaFailureCount;
  let windowMs: number;
  beforeEach(async () => {
    vi.resetModules();
    ({ noteFormulaFailure: note, formulaFailureCount: count, REPORT_WINDOW_MS: windowMs } = await import("./formulaFailure"));
  });

  it("counts every distinct formula and reports once for a lesson full of them", () => {
    const report = vi.fn();
    for (let i = 0; i < 60; i += 1) note(`\\badcommand${i}`, 1000 + i, report);
    expect(count()).toBe(60);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ code: "formula-not-drawn" });
  });

  it("counts a source once, however often it is drawn again", () => {
    const report = vi.fn();
    for (let i = 0; i < 5; i += 1) note("\\frac{1}{", 1000 + i, report);
    expect(count()).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("reports again when a new failure comes after the window, and not before", () => {
    const report = vi.fn();
    note("a", 0, report);
    note("b", windowMs - 1, report);
    expect(report).toHaveBeenCalledTimes(1);
    note("c", windowMs, report);
    expect(report).toHaveBeenCalledTimes(2);
    expect(count()).toBe(3);
  });

  it("sends the code and nothing of the formula", () => {
    const report = vi.fn();
    note("\\secret{private text}", 0, report);
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
  });
});
