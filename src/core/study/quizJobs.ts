import { selectionFor } from "../engine/selection";
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
import { startAttempt, type AttemptResult } from "./attempt";
import { checkedAnswer, DRAFT_GRACE_MS } from "./quizGrading";

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
    retryParams: (raw) => {
      const params = raw as Params;
      return {
        ...params,
        snapshot: { ...params.snapshot, selection: selectionFor(db, "lesson") },
      };
    },
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
/** Diagnostics reuse the quiz item shape but carry no build job or config. When `planId` is given the attempt must belong to that plan. */
export function readQuiz(
  db: Database.Database,
  attemptId: string,
  planId?: string,
) {
  const row = db
    .prepare(
      "SELECT i.kind, i.body_json, i.grounding, a.submitted_at FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ? AND i.kind IN ('quiz', 'diagnostic', 'review') AND (? IS NULL OR a.plan_id = ?)",
    )
    .get(attemptId, planId ?? null, planId ?? null) as
    | {
        kind: string;
        body_json: string;
        grounding: string | null;
        submitted_at: number | null;
      }
    | undefined;
  if (!row) throw new Error("quiz-missing");
  const body = JSON.parse(row.body_json) as {
    config?: { count: number; timerMinutes?: number };
    explanation?: string;
    complete?: boolean;
    questions: Array<{
      id: string;
      stem: string;
      sourceId?: string;
      topicId?: string;
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
        results: AttemptResult[];
        picks: Record<string, string>;
      })
    : undefined;
  const saved = db
    .prepare(
      "SELECT payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object' ORDER BY created_at DESC LIMIT 1",
    )
    .get(attemptId) as { payload_json: string } | undefined;
  const savedBody = saved
    ? (JSON.parse(saved.payload_json) as {
        draft: { picks: Record<string, string>; index: number };
        deadlineAt?: number;
      })
    : undefined;
  const draft = savedBody?.draft;
  return {
    draft,
    explanation: body.explanation,
    timerMinutes: body.config?.timerMinutes,
    deadlineAt: savedBody?.deadlineAt,
    submittedAt: row.submitted_at ?? undefined,
    result,
    questions: body.questions.map(({ answer, ...question }) => ({
      ...question,
      grade: { kind: answer.kind },
    })),
    jobId: job?.id,
    // The quiz screen shows the whole-review progress line for a mixed review's questions.
    review: row.kind === "review" ? true : undefined,
    state:
      row.kind !== "quiz" || body.complete
        ? "succeeded"
        : (job?.state ?? "failed"),
    error: job?.error ?? undefined,
    // LES-32: questions the model wrote without the plan's sources carry a visible tag.
    general: row.grounding === "general" ? true : undefined,
    requestedCount: body.config?.count ?? body.questions.length,
    checked: body.questions.flatMap((question) => {
      const check = checkedAnswer(db, attemptId, question.id);
      return check ? [check] : [];
    }),
  };
}

export function saveQuizDraft(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
  index: number,
  planId?: string,
  now = Date.now(),
) {
  const row = db
    .prepare(
      "SELECT a.submitted_at, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ? AND i.kind IN ('quiz', 'diagnostic', 'review') AND (? IS NULL OR a.plan_id = ?)",
    )
    .get(attemptId, planId ?? null, planId ?? null) as
    { submitted_at: number | null; body_json: string } | undefined;
  if (
    !row ||
    row.submitted_at != null ||
    db
      .prepare(
        "SELECT id FROM jobs WHERE kind = 'quiz-grade' AND json_extract(params_json, '$.attemptId') = ? LIMIT 1",
      )
      .get(attemptId)
  )
    throw new Error("attempt-closed");
  const body = JSON.parse(row.body_json) as {
    config?: { timerMinutes?: number };
    complete?: boolean;
    questions: Array<{ id: string }>;
  };
  const ids = new Set(body.questions.map((question) => question.id));
  if (
    Object.keys(picks).length > 100 ||
    Object.keys(picks).some((id) => !ids.has(id))
  )
    throw new Error("question-missing");
  const existing = db
    .prepare(
      "SELECT id, payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object' LIMIT 1",
    )
    .get(attemptId) as { id: string; payload_json: string } | undefined;
  // The timer starts at the first save once every question exists, and survives restarts in the draft row.
  let deadlineAt = existing
    ? (JSON.parse(existing.payload_json) as { deadlineAt?: number }).deadlineAt
    : undefined;
  const minutes = body.config?.timerMinutes;
  if (deadlineAt == null && minutes && body.complete)
    deadlineAt = now + minutes * 60_000;
  // Answers typed after the deadline (beyond a short save grace) are not kept.
  if (deadlineAt != null && now > deadlineAt + DRAFT_GRACE_MS)
    throw new Error("attempt-closed");
  const payload = JSON.stringify({
    draft: {
      picks,
      index: Math.min(index, Math.max(0, body.questions.length - 1)),
    },
    ...(deadlineAt != null ? { deadlineAt } : {}),
  });
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
