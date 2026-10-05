import { describe, expect, it } from "vitest";
import { pythonOutcome } from "./pythonRun";

const run = { stdout: "", stderr: "", timedOut: false, truncated: false };

describe("pythonOutcome", () => {
  it("shows output and Python errors as they are", () => {
    expect(pythonOutcome({ ...run, stdout: "2\n" })).toMatchObject({
      stdout: "2\n",
      stderr: "",
      notice: null,
    });
    const failed = pythonOutcome({
      ...run,
      stderr: "NameError: name 'x' is not defined",
    });
    expect(failed.stderr).toContain("NameError");
    expect(failed.notice).toBeNull();
  });

  it("keeps the runtime's internal codes off screen", () => {
    expect(pythonOutcome({ ...run, stderr: "runtime-missing" })).toMatchObject({
      stderr: "",
      notice: "setup",
    });
    for (const code of ["runtime-unavailable", "runtime-timeout"])
      expect(pythonOutcome({ ...run, stderr: code })).toMatchObject({
        stderr: "",
        notice: "unavailable",
      });
  });

  it("flags timeouts and truncated output but keeps what was printed", () => {
    expect(
      pythonOutcome({ ...run, stdout: "1", timedOut: true }),
    ).toMatchObject({ stdout: "1", notice: "timeout" });
    expect(pythonOutcome({ ...run, truncated: true }).notice).toBe("truncated");
  });
});
