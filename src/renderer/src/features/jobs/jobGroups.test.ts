import { describe, expect, it } from "vitest";
import type { JobView } from "../../../../shared/ipc";
import { finishedLabelKey, groupJobs } from "./jobGroups";

function job(id: string, over: Partial<JobView> = {}): JobView {
  return {
    id,
    kind: "cards-build",
    state: "failed",
    progress: 0,
    stepLabel: null,
    error: null,
    steps: [],
    updatedAt: 1,
    ...over,
  };
}

describe("jobs list groups", () => {
  it("puts stopped, running and finished jobs in their own group", () => {
    const groups = groupJobs(
      [
        job("a", { state: "failed", error: "cli-failed" }),
        job("b", { state: "running" }),
        job("c", { state: "queued" }),
        job("d", { state: "interrupted" }),
        job("e", { state: "cancelled" }),
      ],
      [job("f", { state: "succeeded" })],
    );
    expect(groups.problems.map((problem) => problem.jobs.map((item) => item.id))).toEqual([
      ["a"],
      ["d"],
      ["e"],
    ]);
    expect(groups.running.map((item) => item.id)).toEqual(["b", "c"]);
    expect(groups.finished.map((item) => item.id)).toEqual(["f"]);
  });

  it("merges jobs that stopped for the same reason into one problem, in the order they started", () => {
    const signedOut = (id: string, error: string) => job(id, { error });
    const groups = groupJobs(
      [
        signedOut("a", "not-logged-in: please run /login"),
        job("odd", { error: "something else" }),
        signedOut("b", "not-logged-in"),
        signedOut("c", "not-logged-in: token expired"),
        signedOut("d", "not-logged-in"),
      ],
      [],
    );
    expect(groups.problems).toHaveLength(2);
    const [engine, general] = groups.problems;
    expect(engine).toMatchObject({
      kind: "engine",
      messageKey: "engines.errors.not-logged-in",
    });
    expect(engine?.jobs.map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
    expect(general).toMatchObject({ kind: "retry", messageKey: "jobs.failedGeneral" });
  });

  it("keeps sign-outs of different engines apart, each with its engine", () => {
    const groups = groupJobs(
      [
        job("a", { error: "not-logged-in [codex]: 401" }),
        job("b", { error: "not-logged-in [agent]: 401" }),
        job("c", { error: "not-logged-in [codex]: 401" }),
      ],
      [],
    );
    expect(
      groups.problems.map((problem) => [
        problem.engine,
        problem.jobs.map((item) => item.id),
      ]),
    ).toEqual([
      ["codex", ["a", "c"]],
      ["agent", ["b"]],
    ]);
  });

  it("keeps different reasons apart, even for the same kind of job", () => {
    const groups = groupJobs(
      [job("a", { error: "not-logged-in" }), job("b", { error: "quota" })],
      [],
    );
    expect(groups.problems.map((problem) => problem.messageKey)).toEqual([
      "engines.errors.not-logged-in",
      "engines.errors.quota",
    ]);
  });

  it("merges interrupted jobs and cancelled jobs, but not with a failure", () => {
    const groups = groupJobs(
      [
        job("a", { state: "interrupted" }),
        job("b", { state: "cancelled" }),
        job("c", { state: "interrupted" }),
        job("d", { state: "cancelled", error: "cli-failed" }),
      ],
      [],
    );
    expect(
      groups.problems.map((problem) => [problem.kind, problem.jobs.map((item) => item.id)]),
    ).toEqual([
      ["interrupted", ["a", "c"]],
      ["retry", ["b", "d"]],
    ]);
  });

  it("offers a retry first for an engine hiccup and the settings for an engine that needs setting up", () => {
    const kinds = (error: string) => groupJobs([job("a", { error })], []).problems[0]?.kind;
    expect(kinds("cli-failed")).toBe("retry");
    expect(kinds("stream-truncated")).toBe("retry");
    expect(kinds("not-logged-in")).toBe("engine");
    expect(kinds("quota")).toBe("engine");
    expect(kinds("model-not-included: not in your plan")).toBe("engine");
    expect(kinds("engine-disclosure-required")).toBe("engine");
    expect(kinds("page-empty")).toBe("retry");
  });

  it("never merges two locked PDFs, since each needs its own password", () => {
    const groups = groupJobs(
      [
        job("a", { error: "pdf-password-required" }),
        job("b", { error: "pdf-password-required" }),
      ],
      [],
    );
    expect(groups.problems.map((problem) => [problem.kind, problem.jobs.length])).toEqual([
      ["locked-pdf", 1],
      ["locked-pdf", 1],
    ]);
  });

  it("leaves out finished work the student never asked for by name", () => {
    const groups = groupJobs(
      [],
      [job("a", { state: "succeeded", kind: "quiz-build" }), job("b", { state: "succeeded", kind: "demo" })],
    );
    expect(groups.finished.map((item) => item.id)).toEqual(["a"]);
    expect(finishedLabelKey("demo")).toBeUndefined();
    expect(finishedLabelKey("quiz-build")).toBe("jobs.done.quizBuild");
  });
});
