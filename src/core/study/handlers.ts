import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  deleteCard,
  dueCards,
  queueCounts,
  rateCard,
  restoreCard,
  saveCard,
  setSuspended,
  suspendedCards,
} from "./cards";
import { browseCards } from "./cardBrowser";
import { mistakesNotebook, startRedo } from "./notebook";
import {
  enqueueTopicCards,
  generateTopicCards,
  readCardsBuild,
  registerCardJobs,
} from "./cardsFromBook";
import { enqueueGapDrill, readGapDrill, registerGapJobs } from "./gapDrill";
import { registerGapInsightJobs } from "./gapInsight";
import { exerciseView, topicExercises } from "./exercises";
import {
  enqueueExercises,
  exerciseJob,
  registerExerciseJobs,
} from "./exerciseJobs";
import {
  requireTopic,
  readLessonItem,
  rewriteLessonSection,
  writeLesson,
  type Wording,
} from "./openLesson";
import { answerSmartCheck, smartAnswers, smartCitations, smartSources } from "./smartText";
import { currentSelfRatings, rateExercise, type SelfRating } from "./selfRating";
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
import {
  addPastPaper,
  pastPaperViews,
  pastStyle,
  registerPastPaperJobs,
  removePastPaper,
  startPastPractice,
} from "./pastPapers";
import { discardReview, readReview, reviewWaiting, skipDrill, startReview } from "./review";
import { diagnosticPreview, startDiagnostic } from "./topicQuiz";
import { citedAnswers } from "./citations";
import { markWrongQuestion, registerWrongQuestionJobs } from "./wrongQuestion";
import { exportAnki } from "../share/anki";
import { ankiRefusal, importApkg, readApkg } from "./ankiImport";
import { exportCardsCsv, exportMarkdown } from "../share/markdown";

import {
  cancelCheck,
  checkQuestion,
  finalizeAttempt,
  gradeConfiguredAttempt,
  gradeOpenAnswers,
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

/** A lesson with what its reader shows besides the text: saved answers and the sources it was given. */
function readingFor(db: Database.Database) {
  return <T extends { itemId?: string; passageIds: string[]; fallback?: boolean }>(
    lesson: T,
  ) => ({
    ...lesson,
    answers: lesson.itemId && !lesson.fallback ? smartAnswers(db, lesson.itemId) : {},
    sources: smartSources(db, lesson.passageIds),
    citations: smartCitations(db, lesson.passageIds),
  });
}

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
    registerPastPaperJobs(db, runner, run);
    registerCardJobs(db, runner, run);
    registerGapJobs(db, runner, run);
    registerGapInsightJobs(db, runner, run);
    registerWrongQuestionJobs(db, runner, run);
  }
  const withReading = readingFor(db);
  return {
    exercises(input: { topicId: string; planId?: string; generate?: boolean }) {
      const scope = input.planId
        ? { planId: input.planId, topicId: input.topicId }
        : null;
      if (input.generate && scope && runner)
        enqueueExercises(db, runner, scope);
      const ratings = currentSelfRatings(db, input.topicId);
      return {
        exercises: topicExercises(db, input.topicId).map((exercise) => ({
          ...exerciseView(exercise),
          rating: ratings.get(exercise.id) ?? null,
        })),
        job: scope ? exerciseJob(db, scope) : null,
      };
    },
    rateExercise(input: {
      planId: string;
      topicId: string;
      exerciseId: string;
      rating: SelfRating;
    }) {
      return rateExercise(db, input);
    },
    lesson(
      input: {
        planId: string;
        topicId: string;
        wording?: Wording;
        regenerate?: boolean;
        /** Read this saved lesson as it was (a finished step); without it, or if it is gone, the topic's lesson opens. */
        itemId?: string;
      },
      options?: {
        signal?: AbortSignal;
        onDelta?: (text: string) => void;
        /** The passages the lesson is written from, with their chip labels, before the text streams. */
        onPassages?: (passageIds: string[], citations: string[]) => void;
      },
    ) {
      const onPassages = options?.onPassages;
      const saved =
        input.itemId && !input.regenerate
          ? readLessonItem(db, input.planId, input.topicId, input.itemId)
          : null;
      if (saved) return Promise.resolve(withReading(saved));
      return writeLesson(db, input.planId, input.topicId, run ?? runTurn, {
        ...options,
        onPassages: onPassages && ((ids) => onPassages(ids, smartCitations(db, ids))),
        wording: input.wording,
        regenerate: input.regenerate,
      }).then((lesson) => withReading(lesson));
    },
    lessonSection(
      input: {
        planId: string;
        topicId: string;
        section: number;
        note?: string;
        wording?: Wording;
      },
      signal?: AbortSignal,
    ) {
      return rewriteLessonSection(db, input.planId, input.topicId, run ?? runTurn, {
        section: input.section,
        note: input.note,
        wording: input.wording,
        signal,
      }).then((lesson) => withReading(lesson));
    },
    lessonAnswer(input: {
      planId: string;
      itemId: string;
      blockId: string;
      pick: number;
    }) {
      return answerSmartCheck(db, input);
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
    anki(input: { planId: string; topicId?: string; history?: boolean }) {
      const result = exportAnki(db, input.planId, input);
      return {
        filename: result.filename,
        base64: Buffer.from(result.bytes).toString("base64"),
        noteCount: result.noteCount,
        cardCount: result.cardCount,
      };
    },
    ankiPreview(input: { path: string }) {
      return ankiRefusal(() => {
        const parsed = readApkg(readFileSync(input.path));
        return {
          format: parsed.format,
          cards: parsed.cards.length,
          ...parsed.skipped,
          reviews: parsed.reviewCount,
        };
      });
    },
    ankiImport(input: {
      path: string;
      planId: string;
      topicId: string;
      history: boolean;
    }) {
      return ankiRefusal(() =>
        importApkg(db, readFileSync(input.path), input),
      );
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
      skipped?: string[];
    }) {
      return saveQuizDraft(
        db,
        input.attemptId,
        input.picks,
        input.index,
        input.planId,
        undefined,
        input.skipped,
      );
    },
    quizRead(input: { attemptId: string; planId?: string }) {
      const quiz = readQuiz(db, input.attemptId, input.planId);
      return {
        ...quiz,
        checked: citedAnswers(db, input.attemptId, quiz.checked),
        result: quiz.result && {
          ...quiz.result,
          results: citedAnswers(db, input.attemptId, quiz.result.results),
        },
      };
    },
    diagnosticStart(input: { planId: string }) {
      return startDiagnostic(db, input.planId);
    },
    diagnosticPreview(input: { planId: string }) {
      return diagnosticPreview(db, input.planId);
    },
    async quizCheck(input: {
      attemptId: string;
      questionId: string;
      pick: string;
    }) {
      const checked = await checkQuestion(
        db,
        runner,
        run,
        input.attemptId,
        input.questionId,
        input.pick,
      );
      return citedAnswers(db, input.attemptId, [checked])[0]!;
    },
    quizCheckCancel(input: { attemptId: string; questionId: string }) {
      return cancelCheck(db, runner, input.attemptId, input.questionId);
    },
    quizWrong(input: { attemptId: string; questionId: string; wrong: boolean }) {
      return markWrongQuestion(db, runner, input);
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
      const submittedAt = Date.now();
      const picks = timedPicks(db, input.attemptId, input.picks, submittedAt);
      const finalize = (
        graded?: Awaited<ReturnType<typeof gradeConfiguredAttempt>>,
      ) => finalizeAttempt(db, input.attemptId, picks, graded, submittedAt);
      if (gate?.kind === "quiz" && JSON.parse(gate.body_json).config)
        return gradeConfiguredAttempt(db, input.attemptId, picks, run).then(
          finalize,
        );
      if (modelGraded)
        return gradeOpenAnswers(db, input.attemptId, picks, run).then(finalize);
      return finalize();
    },
    quizGrading(input: { attemptId: string }) {
      const grading = readQuizGrading(db, input.attemptId);
      return {
        ...grading,
        result: grading.result && {
          ...grading.result,
          results: citedAnswers(db, input.attemptId, grading.result.results),
        },
      };
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
    browse(input: Parameters<typeof browseCards>[1]) {
      return browseCards(db, input, Date.now());
    },
    mistakes(input: { planId?: string }) {
      return mistakesNotebook(db, input);
    },
    mistakesRedo(input: { planId: string; keys: string[] }) {
      return startRedo(db, input);
    },
    restore(input: { cardId: string }) {
      restoreCard(db, input.cardId);
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
    pastPapers(input: { planId: string }) {
      const style = pastStyle(db, input.planId);
      return {
        papers: pastPaperViews(db, input.planId),
        style: style && {
          papers: style.papers,
          questions: style.questions,
          minutes: style.minutes,
          totalPoints: style.totalPoints,
          types: style.types,
          difficulty: style.difficulty,
        },
      };
    },
    pastPaperAdd(input: { planId: string; sourceIds: string[] }) {
      if (!runner) throw new Error("paper-read-unavailable");
      return addPastPaper(db, runner, input.planId, input.sourceIds);
    },
    pastPaperRemove(input: { planId: string; sourceId: string }) {
      removePastPaper(db, runner, input.planId, input.sourceId);
      return { ok: true as const };
    },
    pastPracticeStart(input: { planId: string; sourceId?: string }) {
      return startPastPractice(db, input.planId, input.sourceId);
    },
    simulationStart(input: {
      planId: string;
      minutes?: number;
      source?: "exam" | "mixed";
    }) {
      // No length asked for leaves a prepared exam at the length it was prepared with.
      const minutes = input.minutes;
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
      matchPast?: boolean;
    }) {
      const result = enqueueSimulation(
        db,
        input.planId,
        input.minutes ?? 30,
        Date.now(),
        input.source ?? "exam",
        input.matchPast,
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
