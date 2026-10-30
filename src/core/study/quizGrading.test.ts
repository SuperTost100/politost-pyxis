import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { promptProvenance } from "../engine/prompts";
import { createRunner } from "../jobs/runner";
import { saveQuiz, startAttempt, type QuizQuestion } from "./attempt";
import {
  cancelCheck,
  checkQuestion,
  checkedAnswer,
  finalizeAttempt,
  gradeQuizQuestion,
  readQuizGrading,
  registerQuizGradingJobs,
  submitQuiz,
  timedPicks,
} from "./quizGrading";
import { saveQuizDraft } from "./quizJobs";
import { readSteps } from "../plans/steps";
import { receiveRuntimeReply, setRuntimeSender } from "../math/runtime-client";

type Db = ReturnType<typeof openDatabase>;
const open = (id: string, reference = "ten"): QuizQuestion => ({
  id,
  stem: `Question ${id}`,
  grade: { kind: "open", answer: "", reference },
});
const mcq: QuizQuestion = {
  id: "m",
  stem: "Pick",
  options: ["right", "wrong"],
  grade: { kind: "mcq", picked: -1, correct: 0 },
};

function fixture(questions: QuizQuestion[], kind: "quiz" | "diagnostic") {
  const db = openDatabase(":memory:");
  for (const [feature, model] of [
    ["default", "default-model"],
    ["grading", "chosen"],
  ] as const)
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)",
    ).run(feature, JSON.stringify({ provider: "claude", model }));
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Physics', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Motion', 0, 1)",
  ).run();
  const itemId = saveQuiz(db, "plan", questions);
  const row = db
    .prepare("SELECT body_json FROM items WHERE id = ?")
    .get(itemId) as { body_json: string };
  const body = JSON.parse(row.body_json) as {
    questions: Array<{ topicId?: string }>;
    config?: unknown;
    complete?: boolean;
  };
  body.questions.forEach((question) => (question.topicId = "topic"));
  if (kind === "quiz" && questions.some((q) => q.id === "cfg")) {
    // A configured quiz with immediate feedback, as quizStart builds it.
    body.config = { count: questions.length, feedback: true };
    body.complete = true;
  }
  db.prepare("UPDATE items SET kind = ?, body_json = ? WHERE id = ?").run(
    kind,
    JSON.stringify(body),
    itemId,
  );
  return { db, attemptId: startAttempt(db, "plan", itemId).attemptId };
}

function reply(score: number, model = "grader") {
  const structured = { score, explanation: `Scored ${score}` };
  return {
    structured,
    text: JSON.stringify(structured),
    provider: "claude" as const,
    model,
    inputTokens: 1,
  };
}
const answerOf = (input: { prompt: string }) =>
  (JSON.parse(input.prompt) as { answer: string }).answer;

async function until(
  db: Db,
  attemptId: string,
  ready: (view: ReturnType<typeof readQuizGrading>) => boolean,
) {
  for (let i = 0; i < 400; i++) {
    const view = readQuizGrading(db, attemptId);
    if (ready(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(JSON.stringify(readQuizGrading(db, attemptId)));
}
const submitted = (db: Db, attemptId: string) =>
  (
    db
      .prepare("SELECT submitted_at FROM attempts WHERE id = ?")
      .get(attemptId) as { submitted_at: number | null }
  ).submitted_at;

describe("quiz grading job", () => {
  it("grades open answers sequentially, skips blanks and records open kinds", async () => {
    const { db, attemptId } = fixture(
      [open("a"), open("b"), mcq, open("blank", "")],
      "diagnostic",
    );
    const seen: string[] = [];
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async (input) => {
      seen.push(`${input.selection.model}:${answerOf(input)}`);
      return reply(answerOf(input) === "ten" ? 1 : 0.5);
    });
    const { jobId } = submitQuiz(db, runner, attemptId, {
      a: "ten",
      b: "about ten",
      m: "0",
      blank: "   ",
    });
    // Nothing is final until the job has finished.
    expect(submitted(db, attemptId)).toBeNull();
    expect(readQuizGrading(db, attemptId).result).toBeUndefined();
    const done = await until(
      db,
      attemptId,
      (view) => view.state === "succeeded",
    );
    expect(done.jobId).toBe(jobId);
    expect(seen).toEqual(["chosen:ten", "chosen:about ten"]);
    // The answers the job grades, in its order; the page shows which one is being graded.
    expect(done.pending).toEqual(["a", "b"]);
    expect(done.result!.results.map((row) => row.score)).toEqual([
      1, 0.5, 1, 0,
    ]);
    expect(done.result!.score).toBe(0.625);
    // Provenance of each model grade: actual model and prompt version.
    expect(checkedAnswer(db, attemptId, "a")).toMatchObject({
      provider: "claude",
      model: "grader",
      prompt: promptProvenance("quiz.open-grade"),
    });
    expect(checkedAnswer(db, attemptId, "blank")).toBeUndefined();
    const event = db
      .prepare(
        "SELECT payload_json FROM learning_events WHERE kind = 'answer_given'",
      )
      .get() as { payload_json: string };
    expect(
      (
        JSON.parse(event.payload_json) as {
          questionScores: Array<{ kind: string }>;
        }
      ).questionScores.map((row) => row.kind),
    ).toEqual(["open", "open", "mcq", "open"]);
    db.close();
  });

  it("credits whole-plan questions to their topics exactly once", async () => {
    const { db, attemptId } = fixture([mcq, { ...mcq, id: "second" }], "quiz");
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('other', 'plan', 'Forces', 1, 1)",
    ).run();
    const item = db
      .prepare(
        "SELECT i.id, i.body_json FROM items i JOIN attempts a ON a.item_id = i.id WHERE a.id = ?",
      )
      .get(attemptId) as { id: string; body_json: string };
    const body = JSON.parse(item.body_json);
    body.config = { scope: "plan", count: 10, feedback: false };
    body.complete = true;
    body.questions[1].topicId = "other";
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(
      JSON.stringify(body),
      item.id,
    );
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async () => {
      throw new Error("Closed answers need no model");
    });
    submitQuiz(db, runner, attemptId, { m: "0", second: "1" });
    await until(db, attemptId, (view) => view.state === "succeeded");
    submitQuiz(db, runner, attemptId, { m: "0", second: "1" });
    const rows = db
      .prepare(
        "SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' ORDER BY topic_id",
      )
      .all() as Array<{ topic_id: string; payload_json: string }>;
    expect(
      rows.map((r) => [r.topic_id, JSON.parse(r.payload_json).score]),
    ).toEqual([
      ["other", 0],
      ["topic", 1],
    ]);
    db.close();
  });

  it("records a finished topic quiz as a step on the path, and a whole-plan quiz as none", async () => {
    for (const topicId of ["topic", null]) {
      const { db, attemptId } = fixture([mcq, { ...mcq, id: "second" }], "quiz");
      db.prepare(
        "UPDATE items SET topic_id = ? WHERE id = (SELECT item_id FROM attempts WHERE id = ?)",
      ).run(topicId, attemptId);
      const runner = createRunner(db, () => {});
      registerQuizGradingJobs(db, runner, async () => {
        throw new Error("Closed answers need no model");
      });
      submitQuiz(db, runner, attemptId, { m: "0", second: "1" });
      await until(db, attemptId, (view) => view.state === "succeeded");
      expect(
        readSteps(db, "plan").map(({ activity, topicId, result }) => ({ activity, topicId, result })),
      ).toEqual(topicId ? [{ activity: "quiz", topicId, result: { correct: 1, total: 2 } }] : []);
      db.close();
    }
  });

  it("stamps the evidence, the step and the attempt with the submit time, not the grading time", async () => {
    const { db, attemptId } = fixture([mcq, open("a")], "quiz");
    db.prepare(
      "UPDATE items SET topic_id = 'topic' WHERE id = (SELECT item_id FROM attempts WHERE id = ?)",
    ).run(attemptId);
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async () => reply(1));
    // Submitted at 23:50 the day before; grading finishes now.
    const at = new Date(2026, 0, 1, 23, 50).getTime();
    submitQuiz(db, runner, attemptId, { m: "0", a: "ten" }, at);
    await until(db, attemptId, (view) => view.state === "succeeded");
    expect(submitted(db, attemptId)).toBe(at);
    expect(
      db
        .prepare(
          "SELECT kind, created_at FROM learning_events WHERE kind IN ('answer_given', 'lesson_completed') ORDER BY created_at",
        )
        .all(),
    ).toEqual([
      { kind: "answer_given", created_at: at },
      { kind: "lesson_completed", created_at: at + 1 },
    ]);
    db.close();
  });

  it("makes no model call when every open answer is blank", async () => {
    const { db, attemptId } = fixture([open("a", ""), mcq], "quiz");
    let calls = 0;
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async () => {
      calls++;
      return reply(1);
    });
    // Even an empty reference must not turn a blank answer into full credit.
    submitQuiz(db, runner, attemptId, { a: "" });
    const done = await until(
      db,
      attemptId,
      (view) => view.state === "succeeded",
    );
    expect(calls).toBe(0);
    expect(done.result!.results[0]!.score).toBe(0);
    db.close();
  });

  it("keeps completed grades but uses current engine settings on explicit retry", async () => {
    const { db, attemptId } = fixture(
      [open("a"), open("b"), open("c")],
      "quiz",
    );
    const seen: string[] = [];
    let hang = true;
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async (input) => {
      seen.push(`${input.selection.model}:${answerOf(input)}`);
      if (hang && seen.length === 2)
        await new Promise((_, reject) =>
          input.signal!.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          ),
        );
      return reply(1);
    });
    const { jobId } = submitQuiz(db, runner, attemptId, {
      a: "one",
      b: "two",
      c: "three",
    });
    await until(db, attemptId, (view) => view.done === 1 && seen.length === 2);
    runner.cancel(jobId);
    const stopped = await until(
      db,
      attemptId,
      (view) => view.state === "cancelled",
    );
    runner.dismiss(jobId);
    expect(readQuizGrading(db, attemptId).jobId).toBe(jobId);
    expect(stopped.done).toBe(1);
    expect(checkedAnswer(db, attemptId, "a")?.pick).toBe("one");
    expect(submitted(db, attemptId)).toBeNull();
    // Explicit retry adopts current settings, retaining completed grades.
    db.prepare(
      "UPDATE feature_engines SET selection_json = ? WHERE feature = 'grading'",
    ).run(JSON.stringify({ provider: "claude", model: "changed" }));
    hang = false;
    // Submitting again revives the same job; it does not create a second one.
    expect(
      submitQuiz(db, runner, attemptId, { a: "x", b: "x", c: "x" }).jobId,
    ).toBe(jobId);
    const done = await until(
      db,
      attemptId,
      (view) => view.state === "succeeded",
    );
    expect(seen).toEqual([
      "chosen:one",
      "chosen:two",
      "changed:two",
      "changed:three",
    ]);
    expect(done.result!.picks).toEqual({ a: "one", b: "two", c: "three" });
    expect(
      db
        .prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'quiz-grade'")
        .get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  it("resumes after a restart without asking for finished grades again", async () => {
    const { db, attemptId } = fixture(
      [open("a"), open("b"), open("c")],
      "diagnostic",
    );
    const first: string[] = [];
    const before = createRunner(db, () => {});
    registerQuizGradingJobs(db, before, async (input) => {
      first.push(answerOf(input));
      if (first.length === 2) await new Promise(() => {});
      return reply(1);
    });
    const { jobId } = submitQuiz(db, before, attemptId, {
      a: "one",
      b: "two",
      c: "three",
    });
    await until(db, attemptId, (view) => view.done === 1 && first.length === 2);
    // A new runner marks the unfinished job interrupted, as after an app restart.
    const after = createRunner(db, () => {});
    expect(readQuizGrading(db, attemptId).state).toBe("interrupted");
    const second: string[] = [];
    registerQuizGradingJobs(db, after, async (input) => {
      second.push(answerOf(input));
      return reply(0.5);
    });
    expect(submitQuiz(db, after, attemptId, {}).jobId).toBe(jobId);
    const done = await until(
      db,
      attemptId,
      (view) => view.state === "succeeded",
    );
    expect(second).toEqual(["two", "three"]);
    expect(done.result!.results.map((row) => row.score)).toEqual([1, 0.5, 0.5]);
    db.close();
  });

  it("takes an empty pick as an explicit 'I don't know': scored 0, answer shown, kept as wrong evidence", async () => {
    const closed: QuizQuestion[] = [
      mcq,
      { id: "tf", stem: "True?", grade: { kind: "tf", picked: true, correct: true } },
      {
        id: "fill",
        stem: "Fill {{0}}",
        // Even a question that accepts a blank answer scores 0 when the student said they do not know.
        grade: { kind: "completion", answers: [], accepted: [["x", ""]] },
      },
      {
        id: "pairs",
        stem: "Match",
        left: ["a"],
        right: ["b"],
        grade: { kind: "matching", pairs: [], correct: [["a", "b"]] },
      },
      open("free"),
    ];
    const { db, attemptId } = fixture(closed, "quiz");
    db.prepare(
      "UPDATE items SET topic_id = 'topic' WHERE id = (SELECT item_id FROM attempts WHERE id = ?)",
    ).run(attemptId);
    const runner = createRunner(db, () => {});
    const run: GenerateInput["run"] = async () => {
      throw new Error("An empty answer needs no model");
    };
    registerQuizGradingJobs(db, runner, run);
    for (const question of closed) {
      const checked = await checkQuestion(db, runner, run, attemptId, question.id, "");
      expect(checked).toMatchObject({ id: question.id, score: 0, pick: "" });
      expect(checked.expected).not.toBe("");
      expect(checkedAnswer(db, attemptId, question.id)).toMatchObject({ score: 0, pick: "" });
    }
    // The same empty pick checked again is the same answer, not a locked one.
    await expect(checkQuestion(db, runner, run, attemptId, "m", "")).resolves.toMatchObject({ score: 0 });
    submitQuiz(db, runner, attemptId, Object.fromEntries(closed.map((question) => [question.id, ""])));
    const done = await until(db, attemptId, (view) => view.state === "succeeded");
    expect(done.result!.results.map((row) => row.score)).toEqual([0, 0, 0, 0, 0]);
    const event = db
      .prepare("SELECT payload_json FROM learning_events WHERE kind = 'answer_given'")
      .get() as { payload_json: string };
    expect(
      (JSON.parse(event.payload_json) as { questionScores: Array<{ id: string; score: number }> }).questionScores,
    ).toMatchObject(closed.map((question) => ({ id: question.id, score: 0 })));
    db.close();
  });

  it("starts one job for a double submit and never closes the attempt twice", async () => {
    const { db, attemptId } = fixture([open("a")], "diagnostic");
    let calls = 0;
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async () => {
      calls++;
      return reply(1);
    });
    const first = submitQuiz(db, runner, attemptId, { a: "ten" });
    const second = submitQuiz(db, runner, attemptId, { a: "something else" });
    expect(second.jobId).toBe(first.jobId);
    await until(db, attemptId, (view) => view.state === "succeeded");
    expect(submitQuiz(db, runner, attemptId, { a: "late" }).jobId).toBe(
      first.jobId,
    );
    expect(calls).toBe(1);
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM attempt_answers WHERE json_type(payload_json, '$.results') = 'array'",
        )
        .get(),
    ).toEqual({ n: 1 });
    db.close();
  });

  it("does not save a late interactive grade after cancellation", async () => {
    const { db, attemptId } = fixture([open("cfg")], "quiz");
    const controller = new AbortController();
    await expect(
      gradeQuizQuestion(
        db,
        attemptId,
        "cfg",
        "ten",
        async () => {
          controller.abort();
          return reply(1);
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkedAnswer(db, attemptId, "cfg")).toBeUndefined();
    expect(submitted(db, attemptId)).toBeNull();
    db.close();
  });

  it("limits interactive checks to the runner's model slots", async () => {
    const { db, attemptId } = fixture([open("cfg"), open("two")], "quiz");
    let active = 0;
    let peak = 0;
    const run: GenerateInput["run"] = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return reply(1);
    };
    const runner = createRunner(db, () => {}, {
      "model-cli": 1,
      "model-api": 1,
      local: 1,
      demo: 1,
    });
    registerQuizGradingJobs(db, runner, run);
    const checks = await Promise.all([
      checkQuestion(db, runner, run, attemptId, "cfg", "x"),
      checkQuestion(db, runner, run, attemptId, "two", "y"),
    ]);
    expect(checks.map((row) => row.model)).toEqual(["grader", "grader"]);
    expect(peak).toBe(1);
    // Finished checks leave no job rows behind.
    expect(db.prepare("SELECT count(*) AS n FROM jobs").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("checks an answer right away while background model work holds every slot", async () => {
    // The walkthrough: a quiz was still being written and mistakes from the diagnostic were being analysed when the
    // student checked an open answer. The engine answered the check in ~29 s; the student waited 121 s.
    const { db, attemptId } = fixture([open("cfg")], "quiz");
    const runner = createRunner(db, () => {});
    const slow = (ms: number) => ({
      jobClass: "model-cli" as const,
      steps: [{ name: "call", label: "jobs.cards", run: () => new Promise((resolve) => setTimeout(resolve, ms)) }],
    });
    // Stand-ins with the timing of the real jobs, scaled down: a quiz batch and two mistake analyses.
    runner.register("quiz-build", slow(600));
    runner.register("gap-insight", slow(600));
    runner.start("gap-insight", {});
    runner.start("quiz-build", {});
    runner.start("gap-insight", {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    const run: GenerateInput["run"] = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return reply(1);
    };
    registerQuizGradingJobs(db, runner, run);
    const started = Date.now();
    await checkQuestion(db, runner, run, attemptId, "cfg", "ten");
    // The check costs its own call, not the background work queued before it.
    expect(Date.now() - started).toBeLessThan(400);
    db.close();
  });

  it("counts a model grade of 0.9 or more as fully right, and keeps a lower one as partial credit", async () => {
    for (const [given, stored] of [
      [0.95, 1],
      [0.9, 1],
      [0.89, 0.89],
    ] as const) {
      const { db, attemptId } = fixture([open("a")], "diagnostic");
      const runner = createRunner(db, () => {});
      const run: GenerateInput["run"] = async () => reply(given);
      registerQuizGradingJobs(db, runner, run);
      const checked = await checkQuestion(db, runner, run, attemptId, "a", "una risposta");
      expect(checked.score).toBe(stored);
      db.close();
    }
  });

  it("checks a diagnostic open answer right away, and a cancelled check leaves it editable", async () => {
    const { db, attemptId } = fixture([open("a")], "diagnostic");
    let hang = true;
    const runner = createRunner(db, () => {});
    const run: GenerateInput["run"] = async (input) => {
      if (hang)
        await new Promise((_, reject) =>
          input.signal!.addEventListener(
            "abort",
            () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          ),
        );
      return reply(0.5);
    };
    registerQuizGradingJobs(db, runner, run);
    const pending = checkQuestion(db, runner, run, attemptId, "a", "first try");
    for (let i = 0; i < 200; i++) {
      const job = db
        .prepare("SELECT state FROM jobs WHERE kind = 'quiz-check'")
        .get() as { state: string } | undefined;
      if (job?.state === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    cancelCheck(db, runner, attemptId, "a");
    await expect(pending).rejects.toThrow();
    expect(checkedAnswer(db, attemptId, "a")).toBeUndefined();
    hang = false;
    const checked = await checkQuestion(db, runner, run, attemptId, "a", "second try");
    expect(checked).toMatchObject({ score: 0.5, pick: "second try" });
    // Submitting reuses the check; no second model call is made for it.
    submitQuiz(db, runner, attemptId, { a: "second try" });
    const done = await until(db, attemptId, (view) => view.state === "succeeded");
    expect(done.total).toBe(0);
    expect(done.result!.score).toBe(0.5);
    db.close();
  });

  it("refuses checks after the timer and grades the saved draft, not late input", async () => {
    const { db, attemptId } = fixture([open("cfg"), open("two")], "quiz");
    const item = db
      .prepare("SELECT id, body_json FROM items WHERE kind = 'quiz'")
      .get() as { id: string; body_json: string };
    const body = JSON.parse(item.body_json);
    body.config.timerMinutes = 1;
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(
      JSON.stringify(body),
      item.id,
    );
    const seen: string[] = [];
    const runner = createRunner(db, () => {});
    const run: GenerateInput["run"] = async (input) => {
      seen.push(answerOf(input));
      return reply(1);
    };
    registerQuizGradingJobs(db, runner, run);
    const t0 = 1_000_000;
    // The first save starts the one-minute clock.
    saveQuizDraft(db, attemptId, { cfg: "early" }, 0, undefined, t0);
    await checkQuestion(
      db,
      runner,
      run,
      attemptId,
      "cfg",
      "early",
      t0 + 30_000,
    );
    saveQuizDraft(
      db,
      attemptId,
      { cfg: "early", two: "draft-two" },
      1,
      undefined,
      t0 + 40_000,
    );
    const late = t0 + 60_000 + 6_000;
    await expect(
      checkQuestion(db, runner, run, attemptId, "two", "late", late),
    ).rejects.toThrow("attempt-closed");
    expect(() =>
      saveQuizDraft(db, attemptId, { two: "late" }, 1, undefined, late),
    ).toThrow("attempt-closed");
    const { jobId } = submitQuiz(
      db,
      runner,
      attemptId,
      { cfg: "late", two: "late" },
      late,
    );
    const done = await until(
      db,
      attemptId,
      (view) => view.state === "succeeded" && view.jobId === jobId,
    );
    expect(done.result!.picks).toEqual({ cfg: "early", two: "draft-two" });
    expect(seen).toEqual(["early", "draft-two"]);
    // The answers froze at time-up, so that is when the quiz counts as submitted.
    expect(submitted(db, attemptId)).toBe(t0 + 60_000);
    db.close();
  });

  it("takes no answers on a timed quiz until every question is ready, so none are given off the clock", async () => {
    const { db, attemptId } = fixture([open("cfg"), open("two")], "quiz");
    const item = db
      .prepare("SELECT id, body_json FROM items WHERE kind = 'quiz'")
      .get() as { id: string; body_json: string };
    const body = JSON.parse(item.body_json);
    body.config.timerMinutes = 1;
    body.complete = false;
    const setBody = () =>
      db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(JSON.stringify(body), item.id);
    setBody();
    const runner = createRunner(db, () => {});
    const run: GenerateInput["run"] = async () => reply(1);
    registerQuizGradingJobs(db, runner, run);
    const t0 = 1_000_000;
    expect(() => saveQuizDraft(db, attemptId, { cfg: "early" }, 0, undefined, t0)).toThrow("quiz-building");
    await expect(checkQuestion(db, runner, run, attemptId, "cfg", "early", t0)).rejects.toThrow("quiz-building");
    // Moving between questions is still saved, and starts no clock.
    saveQuizDraft(db, attemptId, {}, 1, undefined, t0);
    expect(checkedAnswer(db, attemptId, "cfg")).toBeUndefined();
    body.complete = true;
    setBody();
    saveQuizDraft(db, attemptId, { cfg: "ready" }, 0, undefined, t0 + 5_000);
    await checkQuestion(db, runner, run, attemptId, "cfg", "ready", t0 + 6_000);
    expect(checkedAnswer(db, attemptId, "cfg")).toMatchObject({ pick: "ready" });
    const deadline = db
      .prepare("SELECT json_extract(payload_json, '$.deadlineAt') AS at FROM attempt_answers WHERE json_type(payload_json, '$.draft') = 'object'")
      .get() as { at: number };
    expect(deadline.at).toBe(t0 + 5_000 + 60_000);
    db.close();
  });

  it("still accepts the final answers sent inside the save grace", () => {
    const { db, attemptId } = fixture([open("cfg")], "quiz");
    const item = db
      .prepare("SELECT id, body_json FROM items WHERE kind = 'quiz'")
      .get() as { id: string; body_json: string };
    const body = JSON.parse(item.body_json);
    body.config.timerMinutes = 1;
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(
      JSON.stringify(body),
      item.id,
    );
    saveQuizDraft(db, attemptId, { cfg: "saved" }, 0, undefined, 0);
    expect(timedPicks(db, attemptId, { cfg: "last" }, 60_000 + 3_000)).toEqual({
      cfg: "last",
    });
    expect(timedPicks(db, attemptId, { cfg: "last" }, 60_000 + 6_000)).toEqual({
      cfg: "saved",
    });
    db.close();
  });
});

describe("diagnostic retakes", () => {
  it("records mastery evidence only for the first attempt on the same questions", () => {
    const { db, attemptId } = fixture([mcq], "diagnostic");
    finalizeAttempt(db, attemptId, { m: "0" });
    const evidence = () =>
      db
        .prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'answer_given'")
        .get() as { n: number };
    expect(evidence()).toEqual({ n: 1 });
    const { item_id: itemId } = db
      .prepare("SELECT item_id FROM attempts WHERE id = ?")
      .get(attemptId) as { item_id: string };
    // A retake of the same diagnostic still gets its result and its step, but no new evidence.
    const retake = startAttempt(db, "plan", itemId).attemptId;
    expect(finalizeAttempt(db, retake, { m: "0" }).score).toBe(1);
    expect(evidence()).toEqual({ n: 1 });
    expect(
      readSteps(db, "plan").filter((step) => step.activity === "diagnostic"),
    ).toHaveLength(2);
    db.close();
  });
});

describe("SymPy in quiz grading", () => {
  type RuntimeRequest = {
    id: string;
    operation: string;
    payload: { answer: string; reference: string };
  };
  // A recorded sandbox: the report for each answer, or no runtime at all for answers it does not know.
  function sandbox(reports: Record<string, unknown>) {
    const asked: string[] = [];
    setRuntimeSender((message) => {
      const request = message as RuntimeRequest;
      asked.push(request.payload.answer);
      const result = reports[request.payload.answer];
      receiveRuntimeReply(
        result
          ? { id: request.id, result }
          : { id: request.id, error: "runtime-missing" },
      );
    });
    return asked;
  }
  afterEach(() => sandbox({}));
  const completion = (id: string, accepted: string): QuizQuestion => ({
    id,
    stem: `Fill ${id}`,
    grade: { kind: "completion", answers: [], accepted: [[accepted]] },
  });

  it("gives the grader the first wrong step and the final verdict", async () => {
    const work = "2x + 3 = 7\n2x = 10\nx = 5";
    sandbox({
      [work]: {
        final: { state: "failed", numbers: [5, 2] },
        steps: 3,
        firstWrong: { index: 2, previous: "2x + 3 = 7", step: "2x = 10" },
      },
    });
    const { db, attemptId } = fixture([open("a", "x = 2")], "quiz");
    const prompts: Array<Record<string, unknown>> = [];
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async (input) => {
      prompts.push(JSON.parse(input.prompt) as Record<string, unknown>);
      return reply(0.3);
    });
    submitQuiz(db, runner, attemptId, { a: work });
    const done = await until(db, attemptId, (view) => view.state === "succeeded");
    expect(prompts[0]).toMatchObject({
      reference: "x = 2",
      answer: work,
      mathCheck: {
        finalAnswer: "different",
        firstWrongStep: { number: 2, previous: "2x + 3 = 7", text: "2x = 10" },
      },
    });
    // The model's grade stands; SymPy informs it.
    expect(done.result!.results[0]!.score).toBe(0.3);
    expect(checkedAnswer(db, attemptId, "a")!.prompt).toEqual({
      template: "quiz.open-grade",
      version: "3",
    });
    db.close();
  });

  it("grades as before, with no mathCheck, when the runtime is missing", async () => {
    const asked = sandbox({});
    const { db, attemptId } = fixture([open("a", "x = 2")], "quiz");
    const prompts: string[] = [];
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async (input) => {
      prompts.push(input.prompt);
      return reply(1);
    });
    submitQuiz(db, runner, attemptId, { a: "x = 2" });
    await until(db, attemptId, (view) => view.state === "succeeded");
    expect(asked).toEqual(["x = 2"]);
    expect(JSON.parse(prompts[0]!)).not.toHaveProperty("mathCheck");
    db.close();
  });

  it("credits a completion answer that is the same mathematics, and saves the credit with the job", async () => {
    const asked = sandbox({
      "1/2": { final: { state: "verified" }, steps: 1 },
      "x^2": { final: { state: "failed" }, steps: 1 },
    });
    const { db, attemptId } = fixture(
      [completion("half", "0.5"), completion("square", "2x"), completion("same", "4")],
      "quiz",
    );
    const runner = createRunner(db, () => {});
    registerQuizGradingJobs(db, runner, async () => reply(1));
    const { jobId } = submitQuiz(db, runner, attemptId, {
      half: "1/2",
      square: "x^2",
      same: "4",
    });
    const done = await until(db, attemptId, (view) => view.state === "succeeded");
    expect(done.result!.results.map((row) => row.score)).toEqual([1, 0, 1]);
    // "4" matched as typed, so only the other two were sent.
    expect(asked).toEqual(["1/2", "x^2"]);
    const params = db
      .prepare("SELECT params_json FROM jobs WHERE id = ?")
      .get(jobId) as { params_json: string };
    expect(JSON.parse(params.params_json).credits).toEqual({ half: 1 });
    db.close();
  });

  it("credits a completion answer checked right away in a configured quiz", async () => {
    sandbox({ "x ≥ 2": { final: { state: "verified" }, steps: 1 } });
    const { db, attemptId } = fixture(
      [{ ...completion("cfg", "[2, +∞)") }],
      "quiz",
    );
    const checked = await gradeQuizQuestion(db, attemptId, "cfg", "x ≥ 2");
    expect(checked).toMatchObject({ score: 1, pick: "x ≥ 2" });
    db.close();
  });
});
