import { uuidv7 } from "../../shared/ids";
import type Database from "better-sqlite3";
import type { GenerateInput } from "../engine/generate";
import type { Runner } from "../jobs/runner";
import {
  generateQuiz,
  prepareQuiz,
  saveQuizSnapshot,
  type QuizInput,
  type QuizSnapshot,
} from "./configuredQuiz";
import { startAttempt } from "./attempt";
import { checkedAnswer } from "./quizGrading";

type Params = {
  input: QuizInput;
  snapshot: QuizSnapshot;
  itemId: string;
  attemptId: string;
};
export function registerQuizJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("quiz-build", {
    jobClass: "model-cli",
    steps: [
      {
        name: "questions",
        label: "quiz.generating",
        async run(ctx) {
          const params = ctx.params as Params;
          await generateQuiz(params.snapshot, run, ctx.signal, () => {
            db.transaction(() => {
              saveQuizSnapshot(
                db,
                params.input,
                params.snapshot,
                params.itemId,
              );
              ctx.setParams(params);
            })();
          });
          if (ctx.signal.aborted)
            throw new DOMException("Cancelled", "AbortError");
          saveQuizSnapshot(db, params.input, params.snapshot, params.itemId);
          return true;
        },
      },
    ],
  });
}
export function enqueueQuiz(
  db: Database.Database,
  runner: Runner,
  input: QuizInput,
) {
  const snapshot = prepareQuiz(db, input);
  const itemId = saveQuizSnapshot(db, input, snapshot);
  const attempt = startAttempt(db, input.planId, itemId);
  runner.start("quiz-build", {
    input,
    snapshot,
    itemId,
    attemptId: attempt.attemptId,
  } satisfies Params);
  return { attemptId: attempt.attemptId, ...readQuiz(db, attempt.attemptId) };
}
export function readQuiz(db: Database.Database, attemptId: string) {
  const row = db
    .prepare(
      "SELECT i.body_json, a.submitted_at FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ? AND i.kind = 'quiz'",
    )
    .get(attemptId) as
    { body_json: string; submitted_at: number | null } | undefined;
  if (!row) throw new Error("quiz-missing");
  const body = JSON.parse(row.body_json) as {
    config: { count: number; feedback: boolean };
    complete: boolean;
    questions: Array<{
      id: string;
      stem: string;
      sourceId?: string;
      options?: string[];
      left?: string[];
      right?: string[];
      answer: { kind: string };
    }>;
  };
  const job = db
    .prepare(
      "SELECT id, state, error FROM jobs WHERE kind = 'quiz-build' AND json_extract(params_json, '$.attemptId') = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(attemptId) as
    { id: string; state: string; error: string | null } | undefined;
  const final =
    row.submitted_at == null
      ? undefined
      : (db
          .prepare(
            "SELECT payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.results') = 'array' ORDER BY created_at DESC LIMIT 1",
          )
          .get(attemptId) as { payload_json: string } | undefined);
  const result = final
    ? (JSON.parse(final.payload_json) as {
        score: number;
        results: Array<{
          id: string;
          score: number;
          expected: string;
          explanation: string;
        }>;
        picks: Record<string, string>;
      })
    : undefined;
  const saved = db
    .prepare(
      "SELECT payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object' ORDER BY created_at DESC LIMIT 1",
    )
    .get(attemptId) as { payload_json: string } | undefined;
  const draft = saved
    ? (
        JSON.parse(saved.payload_json) as {
          draft: { picks: Record<string, string>; index: number };
        }
      ).draft
    : undefined;
  return {
    draft,
    submittedAt: row.submitted_at ?? undefined,
    result,
    questions: body.questions.map(({ answer, ...question }) => ({
      ...question,
      grade: { kind: answer.kind },
    })),
    jobId: job?.id,
    state: body.complete ? "succeeded" : (job?.state ?? "failed"),
    error: job?.error ?? undefined,
    requestedCount: body.config.count,
    feedback: body.config.feedback,
    checked: body.questions.flatMap((question) => {
      const check = checkedAnswer(db, attemptId, question.id);
      return check && (body.config.feedback || row.submitted_at != null)
        ? [check]
        : [];
    }),
  };
}

export function saveQuizDraft(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
  index: number,
) {
  const row = db
    .prepare(
      "SELECT a.submitted_at, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ? AND i.kind = 'quiz'",
    )
    .get(attemptId) as
    { submitted_at: number | null; body_json: string } | undefined;
  if (!row || row.submitted_at != null) throw new Error("attempt-closed");
  const body = JSON.parse(row.body_json) as {
    questions: Array<{ id: string }>;
  };
  const ids = new Set(body.questions.map((question) => question.id));
  if (
    Object.keys(picks).length > 100 ||
    Object.keys(picks).some((id) => !ids.has(id))
  )
    throw new Error("question-missing");
  const payload = JSON.stringify({
    draft: {
      picks,
      index: Math.min(index, Math.max(0, body.questions.length - 1)),
    },
  });
  const existing = db
    .prepare(
      "SELECT id FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object' LIMIT 1",
    )
    .get(attemptId) as { id: string } | undefined;
  const now = Date.now();
  if (existing)
    db.prepare(
      "UPDATE attempt_answers SET payload_json = ?, created_at = ? WHERE id = ?",
    ).run(payload, now, existing.id);
  else
    db.prepare(
      "INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(uuidv7(now), attemptId, payload, now);
  return { ok: true as const };
}
