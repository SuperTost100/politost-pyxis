import type Database from "better-sqlite3";
import type { GenerateInput } from "../engine/generate";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { syncGaps } from "../plans/progress";
import {
  attemptScore,
  QUIZ_MAX_QUESTIONS,
  questionFlagged,
  type AttemptResult,
  type StoredQuestion,
} from "./attempt";
import { generateQuiz, prepareQuiz } from "./configuredQuiz";
import { flaggedIds, flagTarget, unflagTarget } from "./flags";
import { deriveDiagnostic, latestGeneratedDiagnostic } from "./topicQuiz";

type ReplaceParams = {
  planId: string;
  topicId: string;
  /** The question marked wrong, and the flag target it was stored under. */
  questionId: string;
  target: string;
  selection?: ReturnType<typeof selectionFor>;
};

function attemptQuestion(
  db: Database.Database,
  attemptId: string,
  questionId: string,
) {
  const row = db
    .prepare(
      "SELECT a.plan_id, i.id AS item_id, i.kind, i.engine_provider, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?",
    )
    .get(attemptId) as
    | {
        plan_id: string;
        item_id: string;
        kind: string;
        engine_provider: string | null;
        body_json: string;
      }
    | undefined;
  if (!row || !["quiz", "diagnostic", "review"].includes(row.kind))
    throw new Error("quiz-missing");
  const questions = (JSON.parse(row.body_json) as { questions: StoredQuestion[] })
    .questions;
  const question = questions.find((item) => item.id === questionId);
  if (!question) throw new Error("question-missing");
  return { row, questions, question };
}

/** Recomputes a submitted attempt's score with the questions now marked wrong left out. */
function rescore(db: Database.Database, attemptId: string, questions: StoredQuestion[]) {
  const saved = db
    .prepare(
      "SELECT id, payload_json FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.results') = 'array' ORDER BY created_at DESC LIMIT 1",
    )
    .get(attemptId) as { id: string; payload_json: string } | undefined;
  if (!saved) return undefined;
  const blocked = flaggedIds(db, "exercise");
  const payload = JSON.parse(saved.payload_json) as {
    results: AttemptResult[];
    score: number;
  };
  payload.results = payload.results.map(({ flagged: _, ...result }) => {
    const question = questions.find((item) => item.id === result.id);
    return question && questionFlagged(blocked, question)
      ? { ...result, flagged: true }
      : result;
  });
  payload.score = attemptScore(payload.results);
  db.prepare("UPDATE attempt_answers SET payload_json = ? WHERE id = ?").run(
    JSON.stringify(payload),
    saved.id,
  );
  return payload.score;
}

/**
 * "Domanda sbagliata?": nobody receives a report. The question is flagged, leaves this attempt's score and every
 * later quiz, and a diagnostic question gets a new one written in its place. `wrong: false` undoes it.
 */
export function markWrongQuestion(
  db: Database.Database,
  runner: Runner | undefined,
  input: { attemptId: string; questionId: string; wrong: boolean },
) {
  const { row, questions, question } = attemptQuestion(
    db,
    input.attemptId,
    input.questionId,
  );
  const target = question.sourceId ?? question.id;
  const score = db.transaction(() => {
    if (input.wrong) flagTarget(db, "exercise", target, "wrong-question");
    else unflagTarget(db, "exercise", target);
    const rescored = rescore(db, input.attemptId, questions);
    syncGaps(db, row.plan_id);
    return rescored;
  })();
  const pending = db
    .prepare(
      "SELECT id FROM jobs WHERE kind = 'quiz-replace' AND state IN ('queued', 'running', 'interrupted') AND json_extract(params_json, '$.target') = ?",
    )
    .all(target) as Array<{ id: string }>;
  if (!input.wrong) for (const job of pending) runner?.cancel(job.id);
  // Only a model-written diagnostic is asked again as it is; other quizzes are written fresh, or drawn from exercises,
  // and already skip what was marked wrong.
  else if (
    runner &&
    !pending.length &&
    row.kind === "diagnostic" &&
    row.engine_provider &&
    question.topicId &&
    question.answer.kind === "mcq"
  )
    runner.start("quiz-replace", {
      planId: row.plan_id,
      topicId: question.topicId,
      questionId: question.id,
      target,
      selection: selectionFor(db, "lesson"),
    } satisfies ReplaceParams);
  return { ok: true as const, ...(score == null ? {} : { score }) };
}

export function registerWrongQuestionJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("quiz-replace", {
    retryParams: (params) => ({
      ...(params as ReplaceParams),
      selection: selectionFor(db, "lesson"),
    }),
    jobClass: "model-cli",
    steps: [
      {
        name: "question",
        label: "jobs.quizReplacing",
        async run(ctx) {
          const params = ctx.params as ReplaceParams;
          const stillWrong = () =>
            flaggedIds(db, "exercise").has(params.target);
          const latest = latestGeneratedDiagnostic(db, params.planId);
          if (!stillWrong() || !latest) return true;
          const blocked = flaggedIds(db, "exercise");
          const kept = (
            JSON.parse(latest.body_json) as { questions: StoredQuestion[] }
          ).questions.filter((question) => !questionFlagged(blocked, question));
          const snapshot = prepareQuiz(db, {
            planId: params.planId,
            topicId: params.topicId,
            scope: "topic",
            types: ["mcq"],
          });
          if (params.selection) snapshot.selection = params.selection;
          // The diagnostic's other questions go first so the new one differs from all of them.
          snapshot.questions = kept.map(({ answer, ...question }) => ({
            ...question,
            grade: answer,
          }));
          snapshot.config.count = kept.length + 1;
          await generateQuiz(snapshot, run, ctx.signal);
          ctx.signal.throwIfAborted();
          const written = snapshot.questions.at(-1)!;
          db.transaction(() => {
            const current = latestGeneratedDiagnostic(db, params.planId);
            if (!stillWrong() || !current) return;
            const now = flaggedIds(db, "exercise");
            const stored = (
              JSON.parse(current.body_json) as { questions: StoredQuestion[] }
            ).questions;
            const { grade, ...rest } = written;
            const replacement: StoredQuestion = {
              ...rest,
              topicId: params.topicId,
              answer: grade,
            };
            const at = stored.findIndex(
              (question) => question.id === params.questionId,
            );
            const next =
              at >= 0
                ? stored.map((question, index) =>
                    index === at ? replacement : question,
                  )
                : [...stored, replacement];
            const usable = next.filter(
              (question) => !questionFlagged(now, question),
            );
            if (usable.length > QUIZ_MAX_QUESTIONS && at < 0) return;
            deriveDiagnostic(db, current.id, usable);
          })();
          return true;
        },
      },
    ],
  });
}
