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
import {
  enqueueTopicCards,
  generateTopicCards,
  readCardsBuild,
  registerCardJobs,
  seedExerciseCards,
} from "./cardsFromBook";
import { enqueueGapDrill, readGapDrill, registerGapJobs } from "./gapDrill";
import { registerGapInsightJobs } from "./gapInsight";
import { exerciseView, topicExercises } from "./exercises";
import {
  enqueueExercises,
  exerciseJob,
  registerExerciseJobs,
} from "./exerciseJobs";
import { requireTopic, writeLesson, type Wording } from "./openLesson";
import type { Rating } from "./schedule";
import { runTurn } from "../engine/funnel";
import {
  activeSimulation,
  enqueueSimulation,
  openSimulation,
  readSimulation,
  readSimulationBuild,
  saveSimulationDraft,
  startSimulation,
  submitSimulation,
  registerSimulationJobs,
} from "./simulation";
import { flagTarget } from "./flags";
import { discardReview, readReview, reviewWaiting, skipDrill, startReview } from "./review";
import { startDiagnostic } from "./topicQuiz";
import { exportAnki } from "../share/anki";
import { exportCardsCsv, exportMarkdown } from "../share/markdown";

import {
  checkQuestion,
  finalizeAttempt,
  gradeConfiguredAttempt,
  gradeOpenAnswers,
  quizAttempt,
  readQuizGrading,
  registerQuizGradingJobs,
  submitQuiz,
  timedPicks,
} from "./quizGrading";
import { startConfiguredQuiz, type QuizInput } from "./configuredQuiz";

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
    registerExerciseJobs(db, runner, run);
    registerQuizGradingJobs(db, runner, run);
    registerSimulationJobs(db, runner, simulationRun);
    registerCardJobs(db, runner, run);
    registerGapJobs(db, runner, run);
    registerGapInsightJobs(db, runner, run);
  }
  return {
    exercises(input: { topicId: string; planId?: string; generate?: boolean }) {
      const scope = input.planId
        ? { planId: input.planId, topicId: input.topicId }
        : null;
      if (input.generate && scope && runner)
        enqueueExercises(db, runner, scope);
      return {
        exercises: topicExercises(db, input.topicId).map(exerciseView),
        job: scope ? exerciseJob(db, scope) : null,
      };
    },
    lesson(
      input: {
        planId: string;
        topicId: string;
        wording?: Wording;
        regenerate?: boolean;
      },
      options?: {
        signal?: AbortSignal;
        onDelta?: (text: string) => void;
        onPassages?: (passageIds: string[]) => void;
      },
    ) {
      return writeLesson(db, input.planId, input.topicId, run ?? runTurn, {
        ...options,
        wording: input.wording,
        regenerate: input.regenerate,
      });
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
    review(input: { planId: string; count?: number }) {
      return startReview(db, input.planId, { count: input.count, runner });
    },
    reviewSession(input: { planId: string }) {
      return readReview(db, input.planId);
    },
    reviewDiscard(input: { planId: string }) {
      return discardReview(db, input.planId);
    },
    reviewSkipDrill(input: { planId: string; jobId: string }) {
      // Only this plan's own unadopted drill is stopped: a queued or running one stops costing model calls, a failed one
      // has nothing to stop. Any other job id, or another plan's drill, is left alone.
      if (skipDrill(db, input.planId, input.jobId)) runner?.cancel(input.jobId);
      return { ok: true as const };
    },
    quizStart(input: QuizInput) {
      return runner
        ? enqueueQuiz(db, runner, input)
        : startConfiguredQuiz(db, input, run);
    },
    quizDraft(input: {
      attemptId: string;
      planId?: string;
      picks: Record<string, string>;
      index: number;
    }) {
      return saveQuizDraft(
        db,
        input.attemptId,
        input.picks,
        input.index,
        input.planId,
      );
    },
    quizRead(input: { attemptId: string; planId?: string }) {
      return readQuiz(db, input.attemptId, input.planId);
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
      return checkQuestion(
        db,
        runner,
        run,
        input.attemptId,
        input.questionId,
        input.pick,
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
      // A gap drill that is still building (or needs recovery) adds questions to this review first.
      if (gate?.kind === "review" && gate.submitted_at == null && reviewWaiting(db, input.attemptId))
        throw new Error("review-drills-pending");
      const modelGraded =
        gate?.kind === "quiz" ||
        gate?.kind === "diagnostic" ||
        gate?.kind === "review";
      // Model grading is a persistent job; the page watches it through quizGrading.
      if (runner && modelGraded)
        return submitQuiz(db, runner, input.attemptId, input.picks);
      // ponytail: without a runner (unit tests) grade inline; the app always has one.
      const picks = timedPicks(db, input.attemptId, input.picks);
      const finalize = (
        graded?: Awaited<ReturnType<typeof gradeConfiguredAttempt>>,
      ) => finalizeAttempt(db, input.attemptId, picks, graded);
      if (gate?.kind === "quiz" && JSON.parse(gate.body_json).config)
        return gradeConfiguredAttempt(db, input.attemptId, picks, run).then(
          finalize,
        );
      if (modelGraded)
        return gradeOpenAnswers(db, input.attemptId, picks, run).then(finalize);
      return finalize();
    },
    quizGrading(input: { attemptId: string }) {
      return readQuizGrading(db, input.attemptId);
    },
    // Reads never generate: building cards is a durable job started by cardsGenerate.
    cards(input: { planId: string; topicId?: string }) {
      return dueCards(db, input.planId, Date.now(), input.topicId);
    },
    queue(input: { planId: string; topicId: string }) {
      return queueCounts(db, input.planId, input.topicId);
    },
    async cardsGenerate(input: { planId: string; topicId: string }) {
      if (runner) return enqueueTopicCards(db, runner, input);
      // ponytail: without a runner (unit tests) generate inline; the app always has one.
      requireTopic(db, input.planId, input.topicId);
      seedExerciseCards(db, input.planId, input.topicId);
      await generateTopicCards(db, input, run);
      return { jobId: null };
    },
    cardsBuild(input: { planId: string; topicId: string }) {
      return readCardsBuild(db, input);
    },
    gapDrillStart(input: { planId: string; topicId: string; gapId?: string }) {
      if (!runner) throw new Error("jobs-unavailable");
      return enqueueGapDrill(db, runner, input);
    },
    gapDrillRead(input: { planId: string; topicId: string; gapId?: string }) {
      return readGapDrill(db, input.planId, input.topicId, input.gapId);
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
    activeSimulation() {
      return activeSimulation(db);
    },
    simulationOpen(input: { planId: string }) {
      return openSimulation(db, input.planId);
    },
    simulationStart(input: {
      planId: string;
      minutes?: number;
      source?: "exam" | "mixed";
    }) {
      // No length asked for leaves a prepared exam at the length it was prepared with.
      const minutes =
        input.minutes === undefined
          ? undefined
          : input.minutes === 60 || input.minutes === 90 || input.minutes === 120
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
    simulationPrepare(input: {
      planId: string;
      minutes?: number;
      source?: "exam" | "mixed";
    }) {
      const result = enqueueSimulation(
        db,
        input.planId,
        input.minutes === 60 || input.minutes === 90 || input.minutes === 120
          ? input.minutes
          : 30,
        Date.now(),
        input.source ?? "exam",
      );
      return "attemptId" in result
        ? { attemptId: result.attemptId }
        : { jobId: result.jobId };
    },
    simulationBuild(input: { planId: string }) {
      return readSimulationBuild(db, input.planId);
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
