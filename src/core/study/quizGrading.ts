import { setTimeout as wait } from "node:timers/promises";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { generate, type GenerateInput } from "../engine/generate";
import { promptProvenance, systemPrompt } from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { recordStep, stepResult } from "../plans/steps";
import { syncGaps } from "../plans/progress";
import { enqueueGapInsights } from "./gapInsight";
import {
  answerOf,
  expectedText,
  submitAttempt,
  type AttemptResult,
  type StoredQuestion,
} from "./attempt";
import { gradeAnswer } from "./grade";
import { recordTopicScores } from "./simulation";

export type CheckedAnswer = {
  id: string;
  score: number;
  expected: string;
  explanation: string;
  pick: string;
  provider?: string;
  model?: string;
  prompt?: { template: string; version: string };
};
export function checkedAnswer(
  db: Database.Database,
  attemptId: string,
  questionId: string,
): CheckedAnswer | undefined {
  const row = db
    .prepare(
      "SELECT payload_json FROM attempt_answers WHERE attempt_id = ? AND json_extract(payload_json, '$.check.id') = ? ORDER BY created_at LIMIT 1",
    )
    .get(attemptId, questionId) as { payload_json: string } | undefined;
  return row
    ? (JSON.parse(row.payload_json) as { check: CheckedAnswer }).check
    : undefined;
}
/** Answers sent this long after the saved deadline are not kept (absorbs a save already in flight). */
export const DRAFT_GRACE_MS = 5_000;
/** The saved draft, and the deadline that its first save started, when the quiz is timed. */
export function quizDraft(db: Database.Database, attemptId: string) {
  const row = db
    .prepare(
      "SELECT payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object' LIMIT 1",
    )
    .get(attemptId) as { payload_json: string } | undefined;
  return row
    ? (JSON.parse(row.payload_json) as {
        draft: { picks: Record<string, string> };
        deadlineAt?: number;
      })
    : undefined;
}
export function quizExpired(
  db: Database.Database,
  attemptId: string,
  now = Date.now(),
) {
  const deadlineAt = quizDraft(db, attemptId)?.deadlineAt;
  return deadlineAt != null && now > deadlineAt + DRAFT_GRACE_MS;
}
/** After the deadline the saved draft is the answer sheet; whatever the caller sends is ignored. */
export function timedPicks(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
  now = Date.now(),
) {
  return quizExpired(db, attemptId, now)
    ? (quizDraft(db, attemptId)?.draft.picks ?? {})
    : picks;
}
export function quizAttempt(db: Database.Database, attemptId: string) {
  const row = db
    .prepare(
      "SELECT a.submitted_at, i.kind, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?",
    )
    .get(attemptId) as
    | { submitted_at: number | null; kind: string; body_json: string }
    | undefined;
  if (!row || row.submitted_at != null) throw new Error("attempt-closed");
  return {
    ...row,
    body: JSON.parse(row.body_json) as {
      complete?: boolean;
      config?: { feedback: boolean };
      questions: StoredQuestion[];
    },
  };
}
/** Every quiz kind is corrected one answer at a time; a simulation has its own grading. */
const CHECKED_KINDS = ["quiz", "diagnostic", "review"];
/** Only non-blank open answers cost a model call; blank ones score 0 without one. */
function needsModel(question: StoredQuestion, pick: string | undefined) {
  return question.answer.kind === "open" && Boolean(pick?.trim());
}
type Engine = { signal?: AbortSignal; selection?: StoredSelection };
/** Model-grade one free/open answer; undefined for other kinds or blank answers. */
async function gradeOpen(
  db: Database.Database,
  question: StoredQuestion,
  pick: string,
  run?: GenerateInput["run"],
  engine: Engine = {},
) {
  if (question.answer.kind !== "open" || !pick.trim()) return undefined;
  const result = await generate({
    selection: engine.selection ?? selectionFor(db, "grading"),
    run,
    signal: engine.signal,
    schema: z.object({
      score: z.number().min(0).max(1),
      explanation: z.string().min(1).max(4000),
    }),
    system: systemPrompt("quiz.open-grade"),
    prompt: JSON.stringify({
      question: question.stem,
      reference: question.answer.reference,
      rubric: question.answer.rubric ?? [
        "Correct central concepts",
        "Coverage of the reference",
        "Reasoning or mathematical working where requested",
      ],
      answer: pick,
    }),
  });
  const data = result.data as { score: number; explanation: string };
  return {
    ...data,
    provider: result.provider,
    model: result.model,
    prompt: promptProvenance("quiz.open-grade"),
  };
}

/** One check row per question: the saved grade and its provenance outlive any job. */
function replaceCheck(
  db: Database.Database,
  attemptId: string,
  checked: CheckedAnswer,
) {
  db.prepare(
    "DELETE FROM attempt_answers WHERE attempt_id = ? AND json_extract(payload_json, '$.check.id') = ?",
  ).run(attemptId, checked.id);
  const now = Date.now();
  db.prepare(
    "INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
  ).run(uuidv7(now), attemptId, JSON.stringify({ check: checked }), now);
}

/**
 * Model-grade open answers of unconfigured quizzes and diagnostics in-process.
 * ponytail: sequential and outside the runner; used only when no runner exists
 * (unit tests). The app grades through the quiz-grade job instead.
 */
export async function gradeOpenAnswers(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
  run?: GenerateInput["run"],
): Promise<Map<string, CheckedAnswer> | undefined> {
  const attempt = quizAttempt(db, attemptId);
  if (
    attempt.kind !== "quiz" &&
    attempt.kind !== "diagnostic" &&
    attempt.kind !== "review"
  )
    return undefined;
  const grades = new Map<string, CheckedAnswer>();
  for (const question of attempt.body.questions) {
    const pick = picks[question.id];
    if (typeof pick !== "string") continue;
    const graded = await gradeOpen(db, question, pick, run);
    if (!graded) continue;
    grades.set(question.id, {
      id: question.id,
      score: graded.score,
      expected: expectedText(question),
      explanation: graded.explanation,
      pick,
      provider: graded.provider,
      model: graded.model,
      prompt: graded.prompt,
    });
  }
  return grades.size ? grades : undefined;
}

export async function gradeQuizQuestion(
  db: Database.Database,
  attemptId: string,
  questionId: string,
  pick: string,
  run?: GenerateInput["run"],
  engine: Engine = {},
): Promise<CheckedAnswer> {
  const attempt = quizAttempt(db, attemptId);
  const stored = checkedAnswer(db, attemptId, questionId);
  if (stored?.pick === pick) return stored;
  // A checked answer is final: its correction has been shown.
  if (stored) throw new Error("answer-locked");
  if (!CHECKED_KINDS.includes(attempt.kind))
    throw new Error("feedback-unavailable");
  const question = attempt.body.questions.find((row) => row.id === questionId);
  if (!question) throw new Error("question-missing");
  let score = gradeAnswer(answerOf(question.answer, pick));
  let explanation = question.explanation ?? "";
  let provenance: Partial<CheckedAnswer> = {};
  if (question.answer.kind === "open" && !pick.trim()) score = 0;
  engine.signal?.throwIfAborted();
  const modelGrade = await gradeOpen(db, question, pick, run, engine);
  engine.signal?.throwIfAborted();
  if (modelGrade) {
    ({ score, explanation } = modelGrade);
    provenance = {
      provider: modelGrade.provider,
      model: modelGrade.model,
      prompt: modelGrade.prompt,
    };
  }
  const checked = {
    id: questionId,
    score,
    expected: expectedText(question),
    explanation,
    pick,
    ...provenance,
  };
  return db.transaction(() => {
    quizAttempt(db, attemptId);
    const concurrent = checkedAnswer(db, attemptId, questionId);
    if (concurrent?.pick === pick) return concurrent;
    if (concurrent) throw new Error("answer-locked");
    replaceCheck(db, attemptId, checked);
    return checked;
  })();
}

export async function gradeConfiguredAttempt(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
  run?: GenerateInput["run"],
): Promise<Map<string, CheckedAnswer> | undefined> {
  const attempt = quizAttempt(db, attemptId);
  if (attempt.kind !== "quiz" || !attempt.body.config) return undefined;
  if (attempt.body.complete === false) throw new Error("quiz-building");
  const grades = new Map<string, CheckedAnswer>();
  for (const question of attempt.body.questions) {
    const checked = checkedAnswer(db, attemptId, question.id);
    const pick = picks[question.id] ?? checked?.pick ?? "";
    grades.set(
      question.id,
      await gradeQuizQuestion(db, attemptId, question.id, pick, run),
    );
  }
  return grades;
}

/**
 * Closes the attempt and records mastery evidence. `graded` holds model or
 * configured grades; every other answer is scored locally by submitAttempt.
 */
export function finalizeAttempt(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
  graded?: Map<string, CheckedAnswer>,
) {
  return db.transaction(() => {
    const frozen = { ...picks };
    if (graded) for (const [id, checked] of graded) frozen[id] ??= checked.pick;
    const scored = submitAttempt(db, attemptId, frozen, Date.now(), graded);
    const row = db
      .prepare(
        `SELECT a.plan_id, i.topic_id, i.kind, i.body_json FROM attempts a
         JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
      )
      .get(attemptId) as
      | {
          plan_id: string;
          topic_id: string | null;
          kind: string;
          body_json: string;
        }
      | undefined;
    if (!row) return scored;
    const now = Date.now();
    const stored = JSON.parse(row.body_json) as {
      questions?: Array<{
        id: string;
        topicId?: string;
        answer?: { kind: string };
        sourceId?: string;
        sourceIds?: string[];
      }>;
    };
    const questions = stored.questions ?? [];
    if (row.topic_id) {
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'answer_given', ?, ?, ?, ?)`,
      ).run(
        uuidv7(now),
        row.plan_id,
        row.topic_id,
        JSON.stringify({
          attemptId,
          score: scored.score,
          scores: scored.results.map((result) => result.score),
          questionScores:
            row.kind === "quiz"
              ? scored.results.map((result) => {
                  const question = questions.find(
                    (item) => item.id === result.id,
                  );
                  return {
                    id: result.id,
                    kind: question?.answer?.kind,
                    sourceIds: [
                      question?.sourceId,
                      ...(question?.sourceIds ?? []),
                    ].filter(Boolean),
                    score: result.score,
                  };
                })
              : undefined,
        }),
        now,
      );
      syncGaps(db, row.plan_id, now);
    } else if (
      row.kind === "simulation" ||
      row.kind === "diagnostic" ||
      row.kind === "review" ||
      row.kind === "quiz"
    ) {
      // A review is practice, not a path step: it records topic scores like a quiz and adds no step.
      if (row.kind !== "review") {
        const drill =
          row.kind === "quiz" &&
          db.prepare("SELECT 1 FROM gap_items WHERE item_id = (SELECT item_id FROM attempts WHERE id = ?)").get(attemptId);
        const activity =
          row.kind === "quiz" ? (drill ? "gaps" : "quiz") : (row.kind as "diagnostic" | "simulation");
        if (row.kind !== "quiz" || row.topic_id)
          recordStep(
            db,
            row.plan_id,
            { activity, topicId: row.topic_id, result: stepResult(scored.results) },
            now + 1,
          );
      }
      // Every diagnostic question carries its answer kind so open answers keep their 1.5 weight.
      recordTopicScores(
        db,
        row.plan_id,
        row.kind === "diagnostic"
          ? questions.map((question) => ({
              ...question,
              answer: question.answer ?? { kind: "open" },
            }))
          : questions,
        scored.results,
        now,
        row.kind === "simulation" ? "simulation" : "quiz",
        attemptId,
      );
      syncGaps(db, row.plan_id, now);
    }
    return scored;
  })();
}

type GradeParams = {
  attemptId: string;
  /** Answers frozen at submit; later edits cannot change what is graded. */
  picks: Record<string, string>;
  /** Running/resumed grading pins its engine; explicit retry refreshes it for unfinished answers. */
  selection?: StoredSelection;
  /** Open questions that still need a model call, in order. */
  pending: string[];
  next: number;
};
type CheckParams = {
  attemptId: string;
  questionId: string;
  pick: string;
  selection: StoredSelection;
};

type JobRow = {
  id: string;
  state: string;
  error: string | null;
  params_json: string;
};
function gradingJob(db: Database.Database, attemptId: string) {
  return db
    .prepare(
      "SELECT id, state, error, params_json FROM jobs WHERE kind = 'quiz-grade' AND json_extract(params_json, '$.attemptId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(attemptId) as JobRow | undefined;
}

export function registerQuizGradingJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("quiz-grade", {
    retryParams: (params) => ({
      ...(params as GradeParams),
      selection: selectionFor(db, "grading"),
    }),
    jobClass: "model-cli",
    steps: [
      {
        name: "grading",
        label: "jobs.quizGrading",
        async run(ctx) {
          const params = ctx.params as GradeParams;
          while (params.next < params.pending.length) {
            ctx.signal.throwIfAborted();
            const attempt = quizAttempt(db, params.attemptId);
            const id = params.pending[params.next]!;
            const question = attempt.body.questions.find(
              (row) => row.id === id,
            );
            if (!question) throw new Error("question-missing");
            const pick = params.picks[id] ?? "";
            const graded = await gradeOpen(db, question, pick, run, {
              signal: ctx.signal,
              selection: params.selection,
            });
            ctx.signal.throwIfAborted();
            if (!graded) throw new Error("grade-missing");
            // Checkpoint: the grade and the cursor commit together, so no completed grade is lost or repeated.
            db.transaction(() => {
              quizAttempt(db, params.attemptId);
              replaceCheck(db, params.attemptId, {
                id,
                score: graded.score,
                expected: expectedText(question),
                explanation: graded.explanation,
                pick,
                provider: graded.provider,
                model: graded.model,
                prompt: graded.prompt,
              });
              params.next += 1;
              ctx.setParams(params);
            })();
          }
          ctx.signal.throwIfAborted();
          finishGrading(db, params);
          enqueueGapInsights(db, runner, params.attemptId);
          return true;
        },
      },
    ],
  });
  // One interactive check still takes a model slot like any other model call.
  runner.register("quiz-check", {
    retryParams: (params) => ({
      ...(params as CheckParams),
      selection: selectionFor(db, "grading"),
    }),
    jobClass: "model-cli",
    steps: [
      {
        name: "check",
        label: "jobs.quizChecking",
        async run(ctx) {
          const params = ctx.params as CheckParams;
          await gradeQuizQuestion(
            db,
            params.attemptId,
            params.questionId,
            params.pick,
            run,
            { signal: ctx.signal, selection: params.selection },
          );
          ctx.signal.throwIfAborted();
          return true;
        },
      },
    ],
  });
}

/** Builds the final grade set from saved checks, then closes the attempt once. */
function finishGrading(db: Database.Database, params: GradeParams) {
  db.transaction(() => {
    const closed = db
      .prepare("SELECT submitted_at FROM attempts WHERE id = ?")
      .get(params.attemptId) as { submitted_at: number | null } | undefined;
    // A crash after closing but before the job was marked done must not close twice.
    if (!closed || closed.submitted_at != null) return;
    const attempt = quizAttempt(db, params.attemptId);
    const configured = attempt.kind === "quiz" && attempt.body.config;
    const graded = new Map<string, CheckedAnswer>();
    for (const question of attempt.body.questions) {
      const pick = params.picks[question.id];
      const stored = checkedAnswer(db, params.attemptId, question.id);
      if (stored && stored.pick === (pick ?? "")) {
        graded.set(question.id, stored);
        continue;
      }
      if (needsModel(question, pick)) throw new Error("grade-missing");
      const local: CheckedAnswer = {
        id: question.id,
        score:
          question.answer.kind === "open"
            ? 0
            : gradeAnswer(answerOf(question.answer, pick)),
        expected: expectedText(question),
        explanation: question.explanation ?? "",
        pick: pick ?? "",
      };
      if (configured) replaceCheck(db, params.attemptId, local);
      if (configured || question.answer.kind === "open")
        graded.set(question.id, local);
    }
    finalizeAttempt(db, params.attemptId, params.picks, graded);
  })();
}

/**
 * Freezes the answers and the grading engine, then starts (or revives) the one
 * grading job of this attempt. Calling it again never starts a second job.
 */
export function submitQuiz(
  db: Database.Database,
  runner: Runner,
  attemptId: string,
  sentPicks: Record<string, string>,
  now = Date.now(),
): { jobId: string } {
  const existing = gradingJob(db, attemptId);
  if (existing) {
    if (existing.state === "interrupted") runner.resume(existing.id);
    else if (existing.state === "failed" || existing.state === "cancelled")
      runner.retry(existing.id);
    return { jobId: existing.id };
  }
  const attempt = quizAttempt(db, attemptId);
  if (
    attempt.kind !== "quiz" &&
    attempt.kind !== "diagnostic" &&
    attempt.kind !== "review"
  )
    throw new Error("grading-unavailable");
  const config = attempt.kind === "quiz" ? attempt.body.config : undefined;
  if (config && attempt.body.complete === false)
    throw new Error("quiz-building");
  const expired = quizExpired(db, attemptId, now);
  const rawPicks = timedPicks(db, attemptId, sentPicks, now);
  const picks: Record<string, string> = {};
  const pending: string[] = [];
  for (const question of attempt.body.questions) {
    // Saved checks survive a dismissed job, so their grades are never asked for twice.
    const checked = checkedAnswer(db, attemptId, question.id);
    const given = rawPicks[question.id];
    // Configured quizzes treat a missing answer as blank; others keep only what was sent.
    const pick = given ?? checked?.pick ?? (config ? "" : undefined);
    if (pick === undefined) continue;
    // Late, a checked answer stays as it was checked rather than failing the forced submit.
    if (checked && checked.pick !== pick) {
      if (!expired) throw new Error("answer-locked");
      picks[question.id] = checked.pick;
      continue;
    }
    picks[question.id] = pick;
    if (needsModel(question, pick) && checked?.pick !== pick)
      pending.push(question.id);
  }
  const params: GradeParams = {
    attemptId,
    picks,
    selection: pending.length ? selectionFor(db, "grading") : undefined,
    pending,
    next: 0,
  };
  return { jobId: runner.start("quiz-grade", params) };
}

/** Interactive per-question check for a configured quiz; model calls go through the runner's slots. */
export async function checkQuestion(
  db: Database.Database,
  runner: Runner | undefined,
  run: GenerateInput["run"] | undefined,
  attemptId: string,
  questionId: string,
  pick: string,
  now = Date.now(),
): Promise<CheckedAnswer> {
  const attempt = quizAttempt(db, attemptId);
  if (quizExpired(db, attemptId, now)) throw new Error("attempt-closed");
  const question = attempt.body.questions.find((row) => row.id === questionId);
  const stored = checkedAnswer(db, attemptId, questionId);
  if (
    !runner ||
    !question ||
    stored?.pick === pick ||
    !needsModel(question, pick)
  )
    return gradeQuizQuestion(db, attemptId, questionId, pick, run);
  if (stored) throw new Error("answer-locked");
  if (!CHECKED_KINDS.includes(attempt.kind))
    throw new Error("feedback-unavailable");
  const jobId = runner.start("quiz-check", {
    attemptId,
    questionId,
    pick,
    selection: selectionFor(db, "grading"),
  } satisfies CheckParams);
  try {
    await jobSettled(db, jobId);
    const saved = checkedAnswer(db, attemptId, questionId);
    if (!saved) throw new Error("grade-missing");
    return saved;
  } finally {
    runner.dismiss(jobId);
  }
}
/** Stops the model check of one answer, if it is still running; the answer stays unchecked and editable. */
export function cancelCheck(
  db: Database.Database,
  runner: Runner | undefined,
  attemptId: string,
  questionId: string,
) {
  const jobs = db
    .prepare(
      "SELECT id FROM jobs WHERE kind = 'quiz-check' AND state IN ('queued', 'running') AND json_extract(params_json, '$.attemptId') = ? AND json_extract(params_json, '$.questionId') = ?",
    )
    .all(attemptId, questionId) as Array<{ id: string }>;
  for (const job of jobs) runner?.cancel(job.id);
  return { ok: true as const };
}
async function jobSettled(db: Database.Database, jobId: string) {
  for (;;) {
    const job = db
      .prepare("SELECT state, error FROM jobs WHERE id = ?")
      .get(jobId) as { state: string; error: string | null } | undefined;
    if (!job) throw new Error("job-missing");
    if (job.state === "succeeded") return;
    if (["failed", "cancelled", "interrupted"].includes(job.state))
      throw new Error(job.error ?? job.state);
    await wait(25);
  }
}

export type QuizGrading = ReturnType<typeof readQuizGrading>;
/** Progress of the attempt's grading job, plus the final result once it is closed. */
export function readQuizGrading(db: Database.Database, attemptId: string) {
  const job = gradingJob(db, attemptId);
  const params = job ? (JSON.parse(job.params_json) as GradeParams) : undefined;
  const last = params?.next
    ? checkedAnswer(db, attemptId, params.pending[params.next - 1]!)
    : undefined;
  const final = db
    .prepare(
      "SELECT payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.results') = 'array' ORDER BY created_at DESC LIMIT 1",
    )
    .get(attemptId) as { payload_json: string } | undefined;
  const result = final
    ? (JSON.parse(final.payload_json) as {
        score: number;
        picks: Record<string, string>;
        results: AttemptResult[];
      })
    : undefined;
  return {
    state: job?.state ?? "none",
    jobId: job?.id,
    error: job?.error ?? undefined,
    done: params?.next ?? 0,
    total: params?.pending.length ?? 0,
    provider: last?.provider,
    model: last?.model,
    result: result
      ? { score: result.score, picks: result.picks, results: result.results }
      : undefined,
  };
}
