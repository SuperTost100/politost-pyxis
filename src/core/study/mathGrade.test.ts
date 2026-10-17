import { afterEach, describe, expect, it } from "vitest";
import { receiveRuntimeReply, setRuntimeSender } from "../math/runtime-client";
import { checkMath, completionScore } from "./mathGrade";

type Request = {
  id: string;
  operation: string;
  payload: { answer: string; reference: string };
};
// A recorded sandbox: each request gets the report the test chose for its answer.
function sandbox(reports: Record<string, unknown>) {
  const requests: Request[] = [];
  setRuntimeSender((message) => {
    const request = message as Request;
    requests.push(request);
    const report = reports[request.payload.answer];
    if (report instanceof Error)
      receiveRuntimeReply({ id: request.id, error: report.message });
    else receiveRuntimeReply({ id: request.id, result: report });
  });
  return requests;
}
const final = (state: string, numbers?: [number, number]) => ({
  final: { state, reason: "expression", ...(numbers ? { numbers } : {}) },
  steps: 1,
});

afterEach(() =>
  // No runtime, as in a workspace that never downloaded it.
  setRuntimeSender((message) =>
    receiveRuntimeReply({
      id: (message as Request).id,
      error: "runtime-missing",
    }),
  ),
);

describe("checkMath", () => {
  it("turns the sandbox report into the prompt's mathCheck", async () => {
    const requests = sandbox({
      "2x+2": final("verified"),
      "2x+3": final("failed"),
      "2x + 3 = 7\n2x = 10\nx = 5": {
        final: { state: "failed", numbers: [5, 2] },
        steps: 3,
        firstWrong: { index: 2, previous: "2x + 3 = 7", step: "2x = 10" },
      },
      "f(2) = 3*4 + 1 = 12": {
        final: { state: "none" },
        steps: 1,
        firstWrong: {
          index: 1,
          previous: "f(2) = 3*4 + 1 = 12",
          step: "f(2) = 3*4 + 1 = 12",
        },
      },
    });
    expect(await checkMath("2x+2", "2(x+1)")).toEqual({
      finalAnswer: "equivalent",
    });
    expect(await checkMath("2x+3", "2(x+1)")).toEqual({
      finalAnswer: "different",
    });
    expect(await checkMath("2x + 3 = 7\n2x = 10\nx = 5", "x = 2")).toEqual({
      finalAnswer: "different",
      firstWrongStep: { number: 2, previous: "2x + 3 = 7", text: "2x = 10" },
    });
    // A mistake inside one line has no separate previous step.
    expect(await checkMath("f(2) = 3*4 + 1 = 12", "13")).toEqual({
      firstWrongStep: { number: 1, text: "f(2) = 3*4 + 1 = 12" },
    });
    expect(requests[0]).toMatchObject({
      operation: "grade",
      payload: { answer: "2x+2", reference: "2(x+1)" },
    });
  });

  it("applies the typed-number tolerance to the two values SymPy returns", async () => {
    sandbox({
      "0.333": final("failed", [0.333, 1 / 3]),
      "0.3": final("failed", [0.3, 1 / 3]),
      "1849": final("failed", [1849, 1848]),
    });
    expect((await checkMath("0.333", "1/3"))?.finalAnswer).toBe("equivalent");
    expect((await checkMath("0.3", "1/3"))?.finalAnswer).toBe("different");
    // Whole numbers must match exactly, as when typed.
    expect((await checkMath("1849", "1848"))?.finalAnswer).toBe("different");
  });

  it("reports nothing when SymPy cannot decide, the runtime is missing or the reply is malformed", async () => {
    const requests = sandbox({
      prose: final("none"),
      missing: { state: "none", reason: "runtime-unavailable" },
      broken: { final: { state: "maybe" } },
      error: new Error("runtime-missing"),
    });
    for (const answer of ["prose", "missing", "broken", "error"])
      expect(await checkMath(answer, "x = 2")).toBeUndefined();
    expect(requests).toHaveLength(4);
  });

  it("does not ask the sandbox about prose references, blanks or a cancelled grading", async () => {
    const requests = sandbox({});
    expect(await checkMath("Garibaldi", "Giuseppe Garibaldi")).toBeUndefined();
    expect(await checkMath("  ", "x = 2")).toBeUndefined();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await checkMath("2", "x = 2", cancelled.signal)).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("stops waiting when the grading is cancelled", async () => {
    setRuntimeSender(() => undefined); // The sandbox never answers.
    const controller = new AbortController();
    const pending = checkMath("2", "x = 2", controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined();
  });
});

describe("completionScore", () => {
  it("credits blanks that are the same mathematics, and keeps the local score otherwise", async () => {
    const requests = sandbox({
      "1/2": final("verified"),
      "2x": final("failed"),
    });
    const grade = {
      kind: "completion" as const,
      answers: ["1/2", "4"],
      accepted: [["0.5"], ["4"]],
    };
    expect(await completionScore(grade, 0.5)).toBe(1);
    // The blank that already matched is not sent.
    expect(requests.map((request) => request.payload)).toEqual([
      { answer: "1/2", reference: "0.5" },
    ]);
    expect(
      await completionScore(
        { kind: "completion", answers: ["2x"], accepted: [["x^2"]] },
        0,
      ),
    ).toBe(0);
    expect(
      await completionScore({ kind: "mcq", picked: 0, correct: 1 }, 0),
    ).toBe(0);
  });

  it("keeps the local score without the runtime", async () => {
    expect(
      await completionScore(
        { kind: "completion", answers: ["1/2"], accepted: [["0.5"]] },
        0,
      ),
    ).toBe(0);
  });
});
