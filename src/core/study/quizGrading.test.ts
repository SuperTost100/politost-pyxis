import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { promptProvenance } from "../engine/prompts";
import { createRunner } from "../jobs/runner";
import { saveQuiz, startAttempt, type QuizQuestion } from "./attempt";
import {
  checkQuestion,
  checkedAnswer,
  gradeQuizQuestion,
  readQuizGrading,
  registerQuizGradingJobs,
  submitQuiz,
  timedPicks,
} from "./quizGrading";
import { saveQuizDraft } from "./quizJobs";

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
