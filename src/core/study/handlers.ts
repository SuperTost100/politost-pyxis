import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  deleteCard,
  dueCards,
  queueCounts,
  rateCard,
  saveCard,
  setSuspended,
  suspendedCards,
} from "./cards";
import { ensureTopicCards } from "./cardsFromBook";
import { topicExercises } from "./exercises";
import { writeLesson } from "./openLesson";
import type { Rating } from "./schedule";
import { completeCurrentStage } from "../plans/create";
import { syncGaps } from "../plans/progress";
import { runTurn } from "../engine/funnel";
import {
  openSimulation,
  readSimulation,
  recordTopicScores,
  saveSimulationDraft,
  startSimulation,
  submitSimulation,
  registerSimulationJobs,
} from "./simulation";
import { flagTarget } from "./flags";
import { startReview } from "./review";
import { startDiagnostic, submitAttempt } from "./topicQuiz";
import { exportAnki } from "../share/anki";
import { exportCardsCsv, exportMarkdown } from "../share/markdown";

import {
  gradeConfiguredAttempt,
  gradeQuizQuestion,
  quizAttempt,
} from "./quizGrading";
import { startConfiguredQuiz, type quizKinds } from "./configuredQuiz";

import type { Runner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import {
  enqueueQuiz,
  readQuiz,
  registerQuizJobs,
  saveQuizDraft,
} from "./quizJobs";

export function studyHandlers(
  db: Database.Database,
  runner?: Runner,
  run: GenerateInput["run"] = runTurn,
  simulationRun: GenerateInput["run"] = runTurn,
) {
  if (runner) {
    registerQuizJobs(db, runner, run);
    registerSimulationJobs(db, runner, simulationRun);
  }
  return {
    exercises(input: { topicId: string }) {
      return topicExercises(db, input.topicId);
    },
    lesson(input: { planId: string; topicId: string }) {
      return writeLesson(db, input.planId, input.topicId, runTurn);
    },
    markdown(input: {
      planId: string;
      kind: "lesson" | "cards" | "quiz" | "simulation";
      topicId?: string;
      answers?: boolean;
      attemptId?: string;
    }) {
      return exportMarkdown(db, input);
    },
    csv(input: { planId: string; topicId?: string }) {
      return exportCardsCsv(db, input);
    },
    anki(input: { planId: string; topicId?: string }) {
      const result = exportAnki(db, input.planId, input);
      return {
        filename: result.filename,
        base64: Buffer.from(result.bytes).toString("base64"),
        noteCount: result.noteCount,
        cardCount: result.cardCount,
      };
    },
    flag(input: { targetKind: string; targetId: string; reason?: string }) {
      flagTarget(db, input.targetKind, input.targetId, input.reason ?? "");
      return { ok: true as const };
    },
    review(input: { planId: string }) {
      return startReview(db, input.planId);
    },
    quizStart(input: {
      planId: string;
      topicId: string;
      count?: number;
      feedback?: boolean;
      types?: Array<(typeof quizKinds)[number]>;
    }) {
      return runner
        ? enqueueQuiz(db, runner, input)
        : startConfiguredQuiz(db, input, run);
    },
    quizDraft(input: {
      attemptId: string;
      picks: Record<string, string>;
      index: number;
    }) {
      return saveQuizDraft(db, input.attemptId, input.picks, input.index);
    },
    quizRead(input: { attemptId: string }) {
      return readQuiz(db, input.attemptId);
    },
    diagnosticStart(input: { planId: string }) {
      return startDiagnostic(db, input.planId);
    },
    async quizCheck(input: {
      attemptId: string;
      questionId: string;
      pick: string;
    }) {
      if (!quizAttempt(db, input.attemptId).body.config?.feedback)
        throw new Error("feedback-unavailable");
      return gradeQuizQuestion(
        db,
        input.attemptId,
        input.questionId,
        input.pick,
        run,
      );
    },
    quizSubmit(input: { attemptId: string; picks: Record<string, string> }) {
      const gate = db
        .prepare(
          `SELECT a.started_at, a.submitted_at, i.kind, i.body_json
           FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
        )
        .get(input.attemptId) as
        | {
            started_at: number;
            submitted_at: number | null;
            kind: string;
            body_json: string;
          }
        | undefined;
      if (gate?.kind === "simulation") throw new Error("use-simulation-submit");
      const finalize = (
        graded?: Awaited<ReturnType<typeof gradeConfiguredAttempt>>,
      ) =>
        db.transaction(() => {
          if (graded)
            for (const [id, checked] of graded)
              input.picks[id] ??= checked.pick;
          const scored = submitAttempt(
            db,
            input.attemptId,
            input.picks,
            Date.now(),
            graded,
          );
          const row = db
            .prepare(
              `SELECT a.plan_id, i.topic_id, i.kind, i.body_json FROM attempts a
           JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
            )
            .get(input.attemptId) as
            | {
                plan_id: string;
                topic_id: string | null;
                kind: string;
                body_json: string;
              }
            | undefined;
          if (row) {
            const now = Date.now();
            const record = (
              topicId: string | null,
              score: number,
              scores: number[],
              at: number,
            ) => {
              db.prepare(
                `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
             VALUES (?, 'answer_given', ?, ?, ?, ?)`,
              ).run(
                uuidv7(at),
                row.plan_id,
                topicId,
                JSON.stringify({
                  score,
                  scores,
                  questionScores:
                    row.kind === "quiz"
                      ? scored.results.map((result) => {
                          const question = (
                            JSON.parse(row.body_json) as {
                              questions: Array<{
                                id: string;
                                sourceId?: string;
                                sourceIds?: string[];
                              }>;
                            }
                          ).questions.find(
                            (question) => question.id === result.id,
                          );
                          return {
                            id: result.id,
                            sourceIds: [
                              question?.sourceId,
                              ...(question?.sourceIds ?? []),
                            ].filter(Boolean),
                            score: result.score,
                          };
                        })
                      : undefined,
                }),
                at,
              );
            };
            if (row.topic_id) {
              record(
                row.topic_id,
                scored.score,
                scored.results.map((result) => result.score),
                now,
              );
              syncGaps(db, row.plan_id, now);
            } else if (row.kind === "simulation" || row.kind === "diagnostic") {
              const stored = JSON.parse(row.body_json) as {
                questions?: Array<{ topicId?: string }>;
              };
              completeCurrentStage(db, row.plan_id, row.kind, now + 1);
              recordTopicScores(
                db,
                row.plan_id,
                stored.questions ?? [],
                scored.results,
                now,
              );
              syncGaps(db, row.plan_id, now);
            }
          }
          return scored;
        })();
      return gate?.kind === "quiz" && JSON.parse(gate.body_json).config
        ? gradeConfiguredAttempt(db, input.attemptId, input.picks, run).then(
            finalize,
          )
        : finalize();
    },
    cards(input: { planId: string; topicId: string }) {
      ensureTopicCards(db, input.planId, input.topicId);
      return dueCards(db, input.planId, Date.now(), input.topicId);
    },
    queue(input: { planId: string; topicId: string }) {
      ensureTopicCards(db, input.planId, input.topicId);
      return queueCounts(db, input.planId, input.topicId);
    },
    save(input: {
      planId: string;
      topicId: string;
      cardId?: string;
      front: string;
      back: string;
    }) {
      return saveCard(db, input);
    },
    remove(input: { cardId: string }) {
      deleteCard(db, input.cardId);
      return { ok: true as const };
    },
    suspend(input: { cardId: string; suspended: boolean }) {
      setSuspended(db, input.cardId, input.suspended);
      return { ok: true as const };
    },
    suspended(input: { planId: string; topicId: string }) {
      return suspendedCards(db, input.planId, input.topicId);
    },
    simulationOpen(input: { planId: string }) {
      return openSimulation(db, input.planId);
    },
    simulationStart(input: {
      planId: string;
      minutes?: number;
      source?: "exam" | "mixed";
    }) {
      const minutes =
        input.minutes === 60 || input.minutes === 90 || input.minutes === 120
          ? input.minutes
          : 30;
      return startSimulation(
        db,
        input.planId,
        minutes,
        Date.now(),
        input.source ?? "exam",
      );
    },
    simulationSubmit(input: {
      attemptId: string;
      picks?: Record<string, string>;
    }) {
      return submitSimulation(db, input.attemptId, input.picks);
    },
    simulationDraft(input: {
      attemptId: string;
      picks: Record<string, string>;
    }) {
      return saveSimulationDraft(db, input.attemptId, input.picks);
    },
    simulationRead(input: { attemptId: string }) {
      return readSimulation(db, input.attemptId);
    },
    rate(input: { cardId: string; rating: Rating }) {
      return rateCard(db, input.cardId, input.rating, Date.now());
    },
    active(input: { planId: string; topicId: string | null; seconds: number }) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'active_time', ?, ?, ?, ?)`,
      ).run(
        uuidv7(now),
        input.planId,
        input.topicId,
        JSON.stringify({ seconds: input.seconds }),
        now,
      );
      return { ok: true as const };
    },
  };
}
