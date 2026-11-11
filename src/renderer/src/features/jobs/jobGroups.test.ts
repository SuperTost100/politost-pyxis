import { describe, expect, it } from "vitest";
import type { JobView } from "../../../../shared/ipc";
import {
  checkJobFor,
  finishedLabelKey,
  requestPath,
  groupJobs,
  jobContext,
  jobTopicName,
  runningLabelKey,
} from "./jobGroups";

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

  it("lists a map request that found nothing under what needs the student, on its own, with a way to its map page", () => {
    const nothing = job("m", {
      kind: "map-build",
      state: "failed",
      error: "map-nothing-matched",
      ref: "map:p1:t1",
    });
    const fromCore = groupJobs([job("b", { state: "running" })], [nothing, job("f", { state: "succeeded" })]);
    expect(fromCore.problems.map((problem) => [problem.kind, problem.messageKey, problem.jobs.map((item) => item.id)])).toEqual([
      ["nothing-found", "map.nothingMatched", ["m"]],
    ]);
    expect(fromCore.finished.map((item) => item.id)).toEqual(["f"]);
    expect(fromCore.finishedItems.map((item) => item.job?.id)).toEqual(["f"]);
    // A list read before core moved it shows it once, in the same place.
    const stale = groupJobs([nothing], [nothing]);
    expect(stale.problems.map((problem) => problem.key)).toEqual(["nothing-found:m"]);
    expect(stale.finished).toEqual([]);
    expect(requestPath(nothing)).toEqual({ to: "/plans/p1/map/t1", state: { job: "m" } });
    expect(requestPath({ ...nothing, ref: "map:s1" })).toEqual({ to: "/maps/s1", state: { job: "m" } });
    // Two requests of one topic lead to one page, and each names its own job.
    const older = requestPath({ ...nothing, id: "old" });
    const newer = requestPath({ ...nothing, id: "new" });
    expect(older?.to).toBe(newer?.to);
    expect(older?.state).toEqual({ job: "old" });
    expect(newer?.state).toEqual({ job: "new" });
    // A map that was built opens nothing from the list, as before; nor does any other failure.
    expect(requestPath({ ...nothing, state: "succeeded", error: null })).toBeUndefined();
    expect(groupJobs([job("x", { kind: "map-build", error: "cli-failed" })], []).problems).toHaveLength(1);
  });

  it("keeps each request that found nothing as its own item, newest first, after the jobs that stopped", () => {
    const nothing = (id: string, updatedAt: number) =>
      job(id, { kind: "map-build", state: "failed", error: "map-nothing-matched", ref: "map:s1", updatedAt });
    const groups = groupJobs(
      [job("stopped", { state: "cancelled" })],
      [nothing("newer", 20), nothing("older", 10)],
    );
    expect(groups.problems.map((problem) => [problem.kind, problem.jobs.map((item) => item.id)])).toEqual([
      ["stopped", ["stopped"]],
      ["nothing-found", ["newer"]],
      ["nothing-found", ["older"]],
    ]);
    // Dismissing one takes it out and leaves the other.
    expect(groupJobs([], [nothing("older", 10)]).problems.map((problem) => problem.jobs[0]?.id)).toEqual(["older"]);
    expect(groupJobs([], []).problems).toEqual([]);
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
      ["stopped", ["b", "d"]],
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

  it("finds the check of this answer, not another one running at the same time", () => {
    const jobs = [
      job("other-answer", { kind: "quiz-check", state: "running", ref: "a1/q1" }),
      job("other-quiz", { kind: "quiz-check", state: "running", ref: "a2/q2" }),
      job("this", { kind: "quiz-check", state: "queued", ref: "a1/q2" }),
      job("done", { kind: "quiz-check", state: "cancelled", ref: "a1/q3" }),
    ];
    expect(checkJobFor(jobs, "a1", "q2")?.id).toBe("this");
    expect(checkJobFor(jobs, "a1", "q3")).toBeUndefined();
    expect(checkJobFor(jobs, "a9", "q1")).toBeUndefined();
  });

  it("lists every long AI job, also the ones a page runs itself, and says what each is about", () => {
    const groups = groupJobs(
      [job("lesson", { state: "running", kind: "lesson-write", inPage: true, topic: "Vettori" })],
      [
        job("cards", { state: "succeeded", kind: "cards-propose", topic: "Vettori" }),
        job("written", { state: "succeeded", kind: "lesson-write", topic: "Vettori" }),
        job("mistakes", { state: "succeeded", kind: "gap-insight", topic: "Vettori" }),
      ],
    );
    expect(groups.running.map((item) => item.id)).toEqual(["lesson"]);
    expect(groups.finished.map((item) => item.id)).toEqual(["cards", "written", "mistakes"]);
    expect(runningLabelKey("lesson-write")).toBe("jobs.doing.lessonWrite");
    expect(runningLabelKey("source-import")).toBeUndefined();
    // The wording picks the topic, or the diagnostic test or the Review a grading is for.
    expect(jobContext(job("q", { topic: "Vettori" }))).toBe("topic");
    expect(jobContext(job("d", { activity: "diagnostic" }))).toBe("diagnostic");
    expect(jobContext(job("r", { activity: "review", topic: "Vettori" }))).toBe("review");
    expect(jobContext(job("p"))).toBeUndefined();
    // A Review that lists its topics names them; a Review's topics read as a short list.
    expect(jobContext(job("r", { activity: "review", topics: ["Vettori"] }))).toBe("reviewTopic");
    const more = (first: string, others: number) => `${first} +${others}`;
    expect(jobTopicName({ topics: ["Vettori"] }, "it", more)).toBe("Vettori");
    expect(jobTopicName({ topics: ["Vettori", "Cinematica"] }, "it", more)).toBe("Vettori e Cinematica");
    expect(jobTopicName({ topics: ["A", "B", "C"] }, "en", more)).toBe("A +2");
    expect(jobTopicName({ topic: "Dinamica" }, "it", more)).toBe("Dinamica");
  });

  describe("jobs of one request", () => {
    const read = (id: string, over: Partial<JobView> = {}) =>
      job(id, { kind: "source-import", state: "queued", group: { id: "folder:f", folder: "Università" }, ...over });

    it("shows a request's jobs as one row, where its first job was, counting what it read and what still waits", () => {
      const groups = groupJobs(
        [
          job("lesson", { kind: "lesson-write", state: "running" }),
          read("a", { state: "running" }),
          job("solo", { kind: "source-import", state: "running" }),
          read("b", { kind: "source-import-vision", group: { id: "folder:f", folder: "Università", waiting: 20 } }),
          read("c"),
        ],
        [read("old", { state: "succeeded" }), job("quiz", { kind: "quiz-build", state: "succeeded" })],
      );
      expect(groups.runningItems.map((item) => item.batch?.key ?? item.job?.id)).toEqual([
        "lesson",
        "source-import|folder:f",
        "solo",
      ]);
      const batch = groups.runningItems[1]!.batch!;
      expect(batch).toMatchObject({ family: "source-import", folder: "Università", waiting: 20 });
      expect(batch.jobs.map((item) => item.id)).toEqual(["a", "b", "c"]);
      expect(batch.done.map((item) => item.id)).toEqual(["old"]);
      // What the running row already counts is not listed again under finished.
      expect(groups.finished.map((item) => item.id)).toEqual(["quiz"]);
      expect(groups.finishedItems.map((item) => item.job?.id)).toEqual(["quiz"]);
      // Every running job stays countable and stoppable on its own.
      expect(groups.running.map((item) => item.id)).toEqual(["lesson", "a", "solo", "b", "c"]);
    });

    it("keeps a lone job of a request as its own row, and other kinds of the same request apart", () => {
      const groups = groupJobs(
        [read("a", { state: "running" }), read("idx", { kind: "source-index" }), read("idx2", { kind: "source-index" })],
        [],
      );
      expect(groups.runningItems.map((item) => item.batch?.key ?? item.job?.id)).toEqual([
        "a",
        "source-index|folder:f",
      ]);
    });

    it("counts a request's finished jobs on its row even when finished jobs of that kind are not listed", () => {
      const index = (id: string, state: JobView["state"]) => read(id, { kind: "source-index", state });
      const groups = groupJobs([index("a", "running"), index("b", "queued")], [index("c", "succeeded")]);
      expect(groups.runningItems[0]!.batch!.done.map((item) => item.id)).toEqual(["c"]);
      expect(groups.finished).toEqual([]);
    });

    it("folds a request that finished into one finished row", () => {
      const groups = groupJobs(
        [],
        [read("x", { state: "succeeded" }), job("quiz", { kind: "quiz-build", state: "succeeded" }), read("y", { state: "succeeded" })],
      );
      expect(groups.finishedItems.map((item) => item.batch?.key ?? item.job?.id)).toEqual(["source-import|folder:f", "quiz"]);
      expect(groups.finishedItems[0]!.batch!.done.map((item) => item.id)).toEqual(["x", "y"]);
      expect(groups.finished.map((item) => item.id)).toEqual(["x", "quiz", "y"]);
    });
  });
});

