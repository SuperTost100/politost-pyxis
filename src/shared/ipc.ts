import { z } from "zod";
import { checkClaimSchema, anchoredCheckSchema } from "./math-check";
import { planFileSchema } from "./plan-file";
import { MAX_IMAGE_BASE64 } from "./source-types";

import {
  conceptGraphSchema as conceptGraph,
  mapOpSchema as mapOp,
  mapSummarySchema,
} from "./concept-map";

/** Engines Pyxis offers. Each one runs in CLI Funnel's text-only mode. */
export const engineProviders = [
  "claude",
  "codex",
  "agent",
  "antigravity",
  "anthropic-api",
  "openai-api",
] as const;
export type EngineProvider = (typeof engineProviders)[number];

export const JobState = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

const dueCardSchema = z.object({
  id: z.string(),
  front: z.string(),
  back: z.string(),
  topicId: z.string().nullable(),
  sectionPath: z.string().nullable(),
  passageId: z.string().nullable(),
  sourceId: z.string().nullable(),
  chapter: z.number().nullable(),
  state: z.object({
    intervalDays: z.number(),
    ease: z.number(),
    dueAt: z.number(),
  }),
});

/** One mixed review: its remaining cards and one progress count over cards plus questions (LES-13). */
const citationSchema = z.object({ passageId: z.string(), label: z.string() });
const quizResultSchema = z.object({
  score: z.number(),
  picks: z.record(z.string(), z.string()),
  results: z.array(
    z.object({
      id: z.string(),
      score: z.number(),
      expected: z.string(),
      explanation: z.string(),
      // Source chips for [Pn] references in the explanation.
      citations: z.array(citationSchema),
      // Marked wrong by the student; shown but not scored.
      flagged: z.boolean().optional(),
    }),
  ),
});
const reviewSessionSchema = z.object({
  sessionId: z.string(),
  cards: z.array(dueCardSchema),
  attemptId: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      sourceId: z.string().optional(),
      stem: z.string(),
      grade: z.object({ kind: z.string() }),
      options: z.array(z.string()).optional(),
      left: z.array(z.string()).optional(),
      right: z.array(z.string()).optional(),
    }),
  ),
  progress: z.object({
    done: z.number(),
    total: z.number(),
    cardsDone: z.number(),
    cardsTotal: z.number(),
    questionsDone: z.number(),
    questionsTotal: z.number(),
    // Questions a gap drill still owes: expected, not done, and part of `total`.
    questionsPending: z.number(),
  }),
  next: z.enum(["cards", "questions", "waiting", "done"]),
  // Gap drills that have not delivered; delivered ones are already among the questions.
  // `state` is the drill job's state, or "skipped" after the student chose to go on without it; a skipped drill is not waited for.
  drills: z.array(
    z.object({
      topicId: z.string(),
      gapId: z.string().optional(),
      title: z.string(),
      jobId: z.string(),
      state: z.string(),
      want: z.number(),
    }),
  ),
  // LES-03: the short explanation of each drill whose questions are already in the review.
  explanations: z.array(
    z.object({
      topicId: z.string(),
      gapId: z.string().optional(),
      title: z.string(),
      text: z.string(),
    }),
  ),
});

export const simulationViewSchema = z.object({
  attemptId: z.string(),
  planId: z.string(),
  deadline: z.number(),
  leftMs: z.number(),
  submitted: z.boolean(),
  locked: z.boolean(),
  blocked: z.string().optional(),
  generated: z.object({ provider: z.string(), model: z.string() }).optional(),
  questions: z.array(z.object({ id: z.string(), stem: z.string() })),
  picks: z.record(z.string(), z.string()),
  topics: z.array(
    z.object({ id: z.string(), title: z.string(), score: z.number() }),
  ),
  grading: z
    .object({
      jobId: z.string(),
      state: JobState,
      progress: z.number(),
      error: z.string().nullable(),
      provider: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
  score: z.number().optional(),
  results: z
    .array(
      z.object({
        id: z.string(),
        score: z.number(),
        expected: z.string(),
        feedback: z.string(),
        missed: z.array(z.string()),
        provider: z.string(),
        model: z.string(),
      }),
    )
    .optional(),
});

export const JobStepView = z.object({
  name: z.string(),
  label: z.string(),
  state: z.enum(["pending", "running", "succeeded", "failed"]),
});

export const JobView = z.object({
  id: z.string(),
  kind: z.string(),
  state: JobState,
  progress: z.number(),
  stepLabel: z.string().nullable(),
  error: z.string().nullable(),
  steps: z.array(JobStepView),
});

export type JobView = z.infer<typeof JobView>;

export const IpcErrorBody = z.object({
  code: z.string(),
  messageKey: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  detail: z.string(),
});

export type IpcErrorBody = z.infer<typeof IpcErrorBody>;

export class IpcError extends Error {
  readonly params: Record<string, string | number>;
  readonly detail: string;

  constructor(
    readonly code: string,
    readonly messageKey: string,
    params: Record<string, string | number> = {},
    detail = "",
  ) {
    super(code);
    this.params = params;
    this.detail = detail;
  }

  toBody(): IpcErrorBody {
    return {
      code: this.code,
      messageKey: this.messageKey,
      params: this.params,
      detail: this.detail,
    };
  }
}

export function toIpcError(err: unknown): IpcErrorBody {
  if (err instanceof IpcError) return err.toBody();
  if (isAbort(err)) {
    return {
      code: "aborted",
      messageKey: "errors.aborted",
      params: {},
      detail: "",
    };
  }
  return {
    code: "internal",
    messageKey: "errors.internal",
    params: {},
    detail: err instanceof Error ? err.message : "",
  };
}

export function isAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}

const guidedContext = z.object({
  subject: z.string().trim().min(1).max(200),
  semesters: z.array(z.string().trim().min(1).max(40)).min(1).max(12),
  language: z.enum(["it", "en"]),
});

const EducationLevelSchema = z.enum([
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
]);

const engineFeature = z.enum([
  "default",
  "chat",
  "plan",
  "lesson",
  "grading",
  "map",
  "vision",
]);
const engineSelection = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.string().optional(),
  fast: z.boolean().optional(),
  auto: z.boolean().optional(),
});

const SmartAnswers = z.record(z.string(), z.number().int());
const PathActivity = z.enum([
  "intro",
  "diagnostic",
  "lesson",
  "practice",
  "quiz",
  "cards",
  "gaps",
  "simulation",
]);
const StepResult = z.object({
  correct: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
const LessonSources = z.array(
  z.object({
    sourceId: z.string(),
    title: z.string(),
    places: z.array(
      z.object({
        passageId: z.string(),
        page: z.number().optional(),
        slide: z.number().optional(),
        chapter: z.number().optional(),
        section: z.string().optional(),
      }),
    ),
  }),
);
const LessonOutput = z.object({
  markdown: z.string(),
  passageIds: z.array(z.string()),
  fallback: z.boolean().optional(),
  /** The lesson row its answers belong to. */
  itemId: z.string().optional(),
  wording: z.enum(["simple", "balanced", "technical"]).optional(),
  /** Written from the model's general knowledge, not the sources. */
  general: z.boolean().optional(),
  /** Written by an earlier lesson prompt, before smart text: Markdown with citations, until rewritten. */
  earlier: z.boolean().optional(),
  /** Saved picks of the lesson's quick checks and recap, by question id. */
  answers: SmartAnswers,
  /** The sources and places the lesson was given, for its "Sources used" footer. */
  sources: LessonSources,
});

export const requests = {
  "jobs.list": { input: z.object({}), output: z.array(JobView) },
  "jobs.startDemo": {
    input: z.object({ failOnce: z.boolean().optional() }),
    output: z.object({ jobId: z.string() }),
  },
  "jobs.cancel": {
    input: z.object({ jobId: z.string() }),
    output: z.object({}),
  },
  "jobs.retry": {
    input: z.object({ jobId: z.string() }),
    output: z.object({}),
  },
  "jobs.resume": {
    input: z.object({ jobId: z.string() }),
    output: z.object({}),
  },
  "jobs.dismiss": {
    input: z.object({ jobId: z.string() }),
    output: z.object({}),
  },
  "engines.overview": {
    input: z.object({}),
    output: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(["cli", "api"]),
        installed: z.boolean(),
        loggedIn: z.boolean(),
        disabled: z.boolean(),
        version: z.string(),
        path: z.string(),
        withinTestedRange: z.boolean(),
        /** The student has seen what this provider receives. Pyxis sends it nothing until then. */
        acknowledged: z.boolean(),
        capabilities: z.object({ effort: z.boolean(), fast: z.boolean() }),
      }),
    ),
  },
  "engines.models": {
    input: z.object({ provider: z.string() }),
    output: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        efforts: z.array(z.object({ id: z.string(), label: z.string() })),
        defaultEffort: z.string().optional(),
        fast: z.boolean(),
      }),
    ),
  },
  "engines.acknowledge": {
    input: z.object({
      providers: z.array(z.enum(engineProviders)).min(1).max(engineProviders.length),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  "engines.test": {
    input: z.object({
      provider: z.string(),
      model: z.string().optional(),
      effort: z.string().optional(),
      fast: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.literal(true),
      latencyMs: z.number(),
      model: z.string(),
      inputTokens: z.number(),
    }),
  },
  "engines.clearFeature": {
    input: z.object({
      feature: z.enum(["chat", "plan", "lesson", "grading", "map", "vision"]),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  "engines.setFeature": {
    input: z.object({
      feature: engineFeature,
      provider: z.string(),
      model: z.string(),
      effort: z.string().optional(),
      fast: z.boolean().optional(),
    }),
    output: z.object({ warning: z.string().nullable() }),
  },
  "engines.features": {
    input: z.object({}),
    output: z.record(z.string(), engineSelection),
  },
  "engines.autoConfigure": {
    input: z.object({
      /** Un-pin the listed features (all when omitted) before choosing. */
      reset: z.boolean().optional(),
      features: z.array(engineFeature).optional(),
    }),
    output: z.object({
      /** Ids of the engines that are installed, signed in and usable. */
      ready: z.array(z.string()),
      /** Feature choices after the update. `auto: true` means Pyxis chose it. */
      features: z.record(z.string(), engineSelection),
    }),
  },
  "engines.remove": {
    input: z.object({ provider: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "engines.logout": {
    input: z.object({ provider: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "engines.update": {
    input: z.object({ provider: z.string() }),
    output: z.object({ changed: z.boolean(), version: z.string() }),
  },
  "engines.login": {
    input: z.object({ provider: z.string() }),
    output: z.object({
      type: z.string(),
      url: z.string().optional(),
      message: z.string().optional(),
      command: z.array(z.string()).optional(),
    }),
  },
  "engines.capability": {
    input: z.object({
      model: z.string(),
      need: z.enum(["vision", "structured"]),
    }),
    output: z.object({ warning: z.string().nullable() }),
  },
  "engines.sendCode": {
    input: z.object({ provider: z.string(), code: z.string() }),
    output: z.object({}),
  },
  "study.lesson": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      wording: z.enum(["simple", "balanced", "technical"]).optional(),
      regenerate: z.boolean().optional(),
    }),
    output: LessonOutput,
  },
  "study.lessonSection": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      section: z.number().int().min(0),
      note: z.string().max(500).optional(),
      wording: z.enum(["simple", "balanced", "technical"]).optional(),
    }),
    output: LessonOutput,
  },
  "study.lessonAnswer": {
    input: z.object({
      planId: z.string(),
      itemId: z.string(),
      blockId: z.string().max(200),
      pick: z.number().int().min(0).max(9),
    }),
    output: z.object({
      correct: z.boolean(),
      pick: z.number().int(),
      /** True when this answer finished the closing recap and so the reading. */
      finished: z.boolean(),
    }),
  },
  "study.markdown": {
    input: z.object({
      planId: z.string(),
      kind: z.enum(["lesson", "cards", "quiz", "simulation"]),
      attemptId: z.string().optional(),
      topicId: z.string().optional(),
      wording: z.enum(["simple", "balanced", "technical"]).optional(),
      answers: z.boolean().optional(),
    }),
    output: z.object({ filename: z.string(), markdown: z.string() }),
  },
  "study.anki": {
    input: z.object({ planId: z.string(), topicId: z.string().optional() }),
    output: z.object({
      filename: z.string(),
      base64: z.string(),
      noteCount: z.number().int().nonnegative(),
      cardCount: z.number().int().nonnegative(),
    }),
  },
  "study.csv": {
    input: z.object({ planId: z.string(), topicId: z.string().optional() }),
    output: z.object({ filename: z.string(), csv: z.string() }),
  },
  // Shows the intro's facts without starting anything.
  "study.diagnosticPreview": {
    input: z.object({ planId: z.string() }),
    output: z.object({
      count: z.number(),
      answered: z.number(),
      minutes: z.number(),
    }),
  },
  "study.diagnosticStart": {
    input: z.object({ planId: z.string() }),
    output: z.object({
      attemptId: z.string(),
      questions: z.array(
        z.object({
          id: z.string(),
          sourceId: z.string().optional(),
          stem: z.string(),
          grade: z.object({ kind: z.string() }),
          options: z.array(z.string()).optional(),
          left: z.array(z.string()).optional(),
          right: z.array(z.string()).optional(),
        }),
      ),
    }),
  },
  "study.quizStart": {
    input: z.object({
      planId: z.string(),
      topicId: z.string().optional(),
      scope: z.enum(["topic", "plan", "page"]).optional(),
      sourceId: z.string().min(1).optional(),
      page: z.number().int().min(1).max(100000).optional(),
      timerMinutes: z.number().int().min(1).max(180).optional(),
      // Ignored: every quiz now corrects each answer when it is checked.
      feedback: z.boolean().optional(),
      // Core asks at most ten questions whatever is sent here.
      count: z.number().int().min(1).max(100).optional(),
      types: z
        .array(z.enum(["mcq", "tf", "completion", "matching", "open"]))
        .min(1)
        .max(5)
        .optional(),
    }),
    output: z.object({
      attemptId: z.string(),
      questions: z.array(
        z.object({
          id: z.string(),
          sourceId: z.string().optional(),
          stem: z.string(),
          grade: z.object({ kind: z.string() }),
          options: z.array(z.string()).optional(),
          left: z.array(z.string()).optional(),
          right: z.array(z.string()).optional(),
        }),
      ),
    }),
  },
  "study.quizDraft": {
    input: z.object({
      attemptId: z.string(),
      planId: z.string().optional(),
      picks: z.record(z.string(), z.string().max(20000)),
      index: z.number().int().min(0).max(99),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  "study.quizRead": {
    input: z.object({ attemptId: z.string(), planId: z.string().optional() }),
    output: z.object({
      // LES-03: a gap drill's short explanation, shown above its questions.
      explanation: z.string().optional(),
      draft: z
        .object({ picks: z.record(z.string(), z.string()), index: z.number() })
        .optional(),
      submittedAt: z.number().optional(),
      result: quizResultSchema.optional(),
      questions: z.array(
        z.object({
          id: z.string(),
          sourceId: z.string().optional(),
          topicId: z.string().optional(),
          stem: z.string(),
          grade: z.object({ kind: z.string() }),
          options: z.array(z.string()).optional(),
          left: z.array(z.string()).optional(),
          right: z.array(z.string()).optional(),
        }),
      ),
      jobId: z.string().optional(),
      review: z.boolean().optional(),
      state: z.string(),
      error: z.string().optional(),
      general: z.boolean().optional(),
      requestedCount: z.number(),
      // Optional quiz timer: minutes configured, and the persisted wall-clock end once the quiz is ready.
      timerMinutes: z.number().optional(),
      deadlineAt: z.number().optional(),
      checked: z.array(
        z.object({
          id: z.string(),
          score: z.number(),
          expected: z.string(),
          explanation: z.string(),
          citations: z.array(citationSchema),
          pick: z.string(),
          provider: z.string().optional(),
          model: z.string().optional(),
        }),
      ),
    }),
  },
  "study.quizCheck": {
    input: z.object({
      attemptId: z.string(),
      questionId: z.string(),
      pick: z.string(),
    }),
    output: z.object({
      id: z.string(),
      score: z.number(),
      expected: z.string(),
      explanation: z.string(),
      citations: z.array(citationSchema),
      provider: z.string().optional(),
      model: z.string().optional(),
    }),
  },
  // Stops a running model check of one open answer; the answer stays editable.
  "study.quizCheckCancel": {
    input: z.object({ attemptId: z.string(), questionId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  // "Wrong question?": flags the question, leaves it out of this score and later quizzes. `wrong: false` undoes it.
  "study.quizWrong": {
    input: z.object({
      attemptId: z.string(),
      questionId: z.string(),
      wrong: z.boolean(),
    }),
    output: z.object({ ok: z.literal(true), score: z.number().optional() }),
  },
  "study.quizSubmit": {
    input: z.object({
      attemptId: z.string(),
      picks: z.record(z.string(), z.string()),
    }),
    // A grading job id means results are not final; follow it with study.quizGrading.
    output: z.object({
      jobId: z.string().optional(),
      score: z.number().optional(),
      results: z
        .array(
          z.object({
            id: z.string(),
            score: z.number(),
            expected: z.string(),
            explanation: z.string(),
          }),
        )
        .optional(),
    }),
  },
  "study.quizGrading": {
    input: z.object({ attemptId: z.string() }),
    output: z.object({
      state: z.string(),
      jobId: z.string().optional(),
      error: z.string().optional(),
      done: z.number(),
      total: z.number(),
      provider: z.string().optional(),
      model: z.string().optional(),
      result: quizResultSchema
        .optional(),
    }),
  },
  "study.flag": {
    input: z.object({
      targetKind: z.string(),
      targetId: z.string(),
      reason: z.string().optional(),
    }),
    output: z.object({ ok: z.literal(true) }),
  },
  "study.review": {
    // Starts a mixed review, or returns the unfinished one. `count` sizes a new review's cards.
    input: z.object({
      planId: z.string(),
      count: z.number().int().min(1).max(20).optional(),
    }),
    output: reviewSessionSchema,
  },
  "study.reviewSession": {
    input: z.object({ planId: z.string() }),
    output: reviewSessionSchema.nullable(),
  },
  "study.reviewDiscard": {
    // Drops the unfinished review so a new one can start; cards, answers and events stay.
    input: z.object({ planId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "study.reviewSkipDrill": {
    // Goes on without one gap drill; the choice is stored in the review, whatever happens to the job.
    input: z.object({ planId: z.string(), jobId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "study.activeSimulation": {
    input: z.object({}),
    output: z.object({ attemptId: z.string(), planId: z.string() }).nullable(),
  },
  "study.simulationOpen": {
    input: z.object({ planId: z.string() }),
    output: simulationViewSchema.nullable(),
  },
  "study.simulationStart": {
    input: z.object({
      planId: z.string(),
      minutes: z
        .union([z.literal(30), z.literal(60), z.literal(90), z.literal(120)])
        .optional(),
      source: z.enum(["exam", "mixed"]).optional(),
    }),
    output: z.object({
      attemptId: z.string(),
      deadline: z.number(),
      questions: z.array(z.object({ id: z.string(), stem: z.string() })),
    }),
  },
  "study.simulationPrepare": {
    input: z.object({
      planId: z.string(),
      minutes: z
        .union([z.literal(30), z.literal(60), z.literal(90), z.literal(120)])
        .optional(),
      source: z.enum(["exam", "mixed"]).optional(),
    }),
    output: z.object({
      attemptId: z.string().optional(),
      jobId: z.string().optional(),
    }),
  },
  "study.simulationBuild": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        jobId: z.string(),
        state: JobState,
        error: z.string().nullable(),
        progress: z.number(),
        minutes: z.number(),
        provider: z.string().optional(),
        model: z.string().optional(),
      })
      .nullable(),
  },
  "study.simulationRead": {
    input: z.object({ attemptId: z.string() }),
    output: simulationViewSchema,
  },
  "study.simulationDraft": {
    input: z.object({
      attemptId: z.string(),
      picks: z.record(z.string(), z.string()),
    }),
    output: simulationViewSchema,
  },
  "study.simulationSubmit": {
    input: z.object({
      attemptId: z.string(),
      picks: z.record(z.string(), z.string()).optional(),
    }),
    output: simulationViewSchema,
  },
  "study.active": {
    input: z.object({
      planId: z.string(),
      topicId: z.string().nullable(),
      seconds: z.number().int().min(1).max(120),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "study.cards": {
    // Without a topic the whole plan's due cards come back, for the Review session.
    input: z.object({ planId: z.string(), topicId: z.string().optional() }),
    output: z.array(dueCardSchema),
  },
  "study.cardsGenerate": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.object({ jobId: z.string().nullable() }),
  },
  "study.cardsBuild": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.object({ jobId: z.string(), state: z.string() }).nullable(),
  },
  "study.gapDrillStart": {
    // `gapId` names one of the topic's gaps; without it the topic's top gap is drilled.
    input: z.object({ planId: z.string(), topicId: z.string(), gapId: z.string().optional() }),
    output: z.object({ jobId: z.string() }),
  },
  "study.gapDrillRead": {
    input: z.object({ planId: z.string(), topicId: z.string(), gapId: z.string().optional() }),
    output: z
      .object({
        jobId: z.string(),
        state: z.string(),
        attemptId: z.string().nullable(),
      })
      .nullable(),
  },
  "study.queue": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.object({
      fresh: z.number(),
      learning: z.number(),
      mastered: z.number(),
    }),
  },
  "study.save": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      cardId: z.string().optional(),
      front: z.string(),
      back: z.string(),
    }),
    output: z.object({ id: z.string() }),
  },
  "study.remove": {
    input: z.object({ cardId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  "study.suspend": {
    input: z.object({ cardId: z.string(), suspended: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  },
  "study.suspended": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.array(z.object({ id: z.string(), front: z.string() })),
  },
  "study.rate": {
    input: z.object({
      cardId: z.string(),
      rating: z.enum(["again", "hard", "good", "easy"]),
    }),
    output: z.object({
      intervalDays: z.number(),
      ease: z.number(),
      dueAt: z.number(),
    }),
  },
  "study.exercises": {
    input: z.object({
      topicId: z.string(),
      planId: z.string().optional(),
      /** Start the grounded exercise job when the topic has no exercises yet. */
      generate: z.boolean().optional(),
    }),
    output: z.object({
      exercises: z.array(
        z.object({
          id: z.string(),
          prompt: z.string(),
          answer: z.string().nullable(),
          generated: z.boolean(),
          steps: z.array(
            z.object({
              text: z.string(),
              check: z
                .object({
                  kind: z.enum([
                    "equal",
                    "derivative",
                    "integral",
                    "solve",
                    "simplify",
                  ]),
                  expr: z.string(),
                  claimed: z.string(),
                  vars: z.array(z.string()).optional(),
                  step: z.string(),
                })
                .optional(),
            }),
          ),
          hints: z.array(z.string()),
        }),
      ),
      job: z
        .object({
          jobId: z.string(),
          state: z.string(),
          error: z.string().nullable(),
        })
        .nullable(),
    }),
  },
  "tools.check": {
    input: checkClaimSchema,
    output: z.object({
      state: z.enum(["verified", "failed", "none"]),
      reason: z.string().optional(),
    }),
  },
  "tools.runtime": {
    input: z.object({}),
    output: z.object({
      phase: z.enum(["idle", "downloading", "ready", "failed"]),
      bytes: z.number(),
      totalBytes: z.number(),
      error: z.string().optional(),
    }),
  },
  "tools.runtimeDownload": {
    input: z.object({}),
    output: z.object({ jobId: z.string() }),
  },
  "tools.python": {
    input: z.object({ code: z.string().max(8000) }),
    output: z.object({
      images: z.array(z.string()).optional(),
      stdout: z.string(),
      stderr: z.string(),
      timedOut: z.boolean(),
      truncated: z.boolean(),
    }),
  },
  "tools.stagePng": {
    input: z.object({ dataUrl: z.string().max(4_000_000) }),
    output: z.object({ path: z.string() }),
  },
  "maps.list": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.array(mapSummarySchema),
  },
  "maps.build": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z
      .object({
        jobId: z.string(),
        state: JobState,
        progress: z.number(),
        stepLabel: z.string().nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
  },
  "maps.generate": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.object({
      jobId: z.string().optional(),
      maps: z.array(mapSummarySchema),
    }),
  },
  "maps.edit": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
      instruction: z.string().trim().min(1).max(2000),
    }),
    output: conceptGraph,
  },
  "maps.open": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
    }),
    output: conceptGraph,
  },
  "maps.layout": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
      layout: z.enum(["tree", "radial"]),
    }),
    output: conceptGraph,
  },
  "maps.move": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
      nodeId: z.string(),
      x: z.number(),
      y: z.number(),
    }),
    output: conceptGraph,
  },
  "maps.patch": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
      ops: z.array(mapOp),
    }),
    output: conceptGraph,
  },
  "maps.undo": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
    }),
    output: conceptGraph,
  },
  "maps.redo": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      mapId: z.string().optional(),
    }),
    output: conceptGraph,
  },
  "plans.list": {
    input: z.object({}),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        subject: z.string().nullable(),
        daysToExam: z.number().nullable(),
        mastery: z.number(),
        target: z.number(),
        imported: z.boolean(),
        alignedTopics: z.number().int(),
        totalTopics: z.number().int(),
      }),
    ),
  },
  "subjects.add": {
    input: z.object({ name: z.string().trim().min(1).max(120) }),
    output: z.object({ id: z.string(), name: z.string() }),
  },
  "subjects.reorder": {
    input: z.object({ ids: z.array(z.string()).max(1000) }),
    output: z.object({ ok: z.literal(true) }),
  },
  "subjects.rename": {
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(120),
    }),
    output: z.object({ id: z.string(), name: z.string() }),
  },
  "subjects.remove": {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "subjects.list": {
    input: z.object({}),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  "plans.usage": {
    input: z.object({}),
    output: z.array(
      z.object({ id: z.string(), title: z.string(), bytes: z.number() }),
    ),
  },
  "plans.read": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        target: z.number(),
        examAt: z.number().nullable(),
        contentLanguage: z.string().nullable(),
        subject: z.string().nullable(),
        imported: z.boolean(),
        importedFrom: z
          .object({
            author: z.string().nullable(),
            exportedAt: z.number().nullable(),
            importedAt: z.number(),
          })
          .nullable(),
        needsRebuild: z.boolean(),
        topics: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            position: z.number(),
            summary: z.string(),
            sourceIds: z.array(z.string()),
            passageCount: z.number().int().nonnegative(),
            itemCount: z.number().int().nonnegative(),
            firstPassageId: z.string().nullable(),
            chapter: z.number().nullable(),
            grounding: z.enum(["sources", "mixed", "general"]).nullable(),
            items: z.array(
              z.object({
                id: z.string(),
                kind: z.string(),
                createdAt: z.number(),
              }),
            ),
            subtopics: z.array(z.string()),
          }),
        ),
        // What the student finished, in order; the path shows these as done steps.
        steps: z.array(
          z.object({
            id: z.string(),
            activity: PathActivity,
            topicId: z.string().nullable(),
            at: z.number(),
            result: StepResult.nullable(),
          }),
        ),
        sources: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            kind: z.string(),
            status: z.string(),
          }),
        ),
      })
      .nullable(),
  },
  "plans.attachSources": {
    input: z.object({
      planId: z.string(),
      sourceIds: z.array(z.string()).min(1).max(1000),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "plans.removeSource": {
    input: z.object({ planId: z.string(), sourceId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  "plans.item": {
    input: z.object({ planId: z.string(), itemId: z.string() }),
    output: z.object({
      id: z.string(),
      kind: z.string(),
      bodyJson: z.string(),
      passageIds: z.array(z.string()),
    }),
  },
  "plans.openQuiz": {
    input: z.object({ planId: z.string(), itemId: z.string() }),
    output: z.object({ attemptId: z.string() }),
  },
  "plans.settings": {
    input: z.object({
      planId: z.string().min(1),
      title: z.string().trim().min(1).max(200),
      target: z.number().finite().min(0.5).max(1),
      examAt: z.number().int().min(0).max(8_640_000_000_000_000).nullable(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "plans.delete": {
    input: z.object({ planId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  "plans.export": {
    input: z.object({
      planId: z.string(),
      progress: z.boolean().optional(),
      embed: z.boolean().optional(),
      /** Names the profile's display name as the author; on unless false. */
      author: z.boolean().optional(),
    }),
    output: planFileSchema,
  },
  "plans.import": {
    // libraryFor: source index in the file -> library source whose stored original stands in for the missing one (SHR-05).
    input: planFileSchema.extend({
      libraryFor: z.record(z.string().regex(/^\d+$/), z.string()).optional(),
    }),
    output: z.object({ planId: z.string() }),
  },
  "plans.mastery": {
    input: z.object({ planId: z.string() }),
    output: z.array(
      z.object({ id: z.string(), title: z.string(), mastery: z.number() }),
    ),
  },
  "plans.recommend": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        next: z
          .object({
            activity: PathActivity,
            topicId: z.string().nullable(),
            reason: z.enum([
              "intro",
              "diagnostic",
              "due",
              "gaps",
              "examSoon",
              "ready",
              "consolidate",
              "next",
              "weakest",
            ]),
            count: z.number(),
          })
          .nullable(),
        hasIntro: z.boolean(),
        // Per topic in the plan's order: what fits it now and what the chooser shows next to each activity.
        topics: z.array(
          z.object({
            topicId: z.string(),
            mastery: z.number(),
            read: z.boolean(),
            dueCards: z.number(),
            gaps: z.number(),
            suggested: PathActivity,
          }),
        ),
      })
      .nullable(),
  },
  "plans.simulations": {
    input: z.object({ planId: z.string() }),
    output: z.array(
      z.object({
        id: z.string(),
        at: z.number(),
        score: z.number(),
        minutes: z.number(),
      }),
    ),
  },
  "plans.series": {
    input: z.object({ planId: z.string() }),
    output: z.object({
      chart: z.array(
        z.object({ day: z.number(), count: z.number(), mastery: z.number() }),
      ),
      weeks: z.array(z.number()),
      counts: z.record(z.string(), z.array(z.number())),
      gaps: z.array(
        z.object({
          // PRO-02: a stable id per gap; one topic can have several, each with its own misconception.
          gapId: z.string(),
          topicId: z.string(),
          openedAt: z.number(),
          severity: z.enum(["severe", "minor"]),
          // True while the misconception could not be compared with the topic's other gaps, so it may repeat one.
          unmerged: z.boolean().optional(),
          wrongAnswers: z.number(),
          // PRO-02: the model's one-sentence reading of the grouped mistakes; null until it lands, when `misses` carries the fallback.
          misconception: z.string().nullable().optional(),
          misses: z.array(
            z.object({
              question: z.string(),
              expected: z.string(),
              explanation: z.string(),
            }),
          ),
        }),
      ),
      preparation: z.object({
        mastery: z.number(),
        target: z.number(),
        weeklyChange: z.number(),
        onTrack: z.number(),
        totalTopics: z.number(),
        lessons: z.number(),
      }),
      flagged: z.array(
        z.object({
          id: z.string(),
          targetKind: z.string(),
          targetId: z.string(),
          label: z.string(),
          reason: z.string(),
          createdAt: z.number(),
          topicId: z.string().optional(),
        }),
      ),
      pace: z.object({
        week: z.number(),
        peakDay: z.number(),
        peakCount: z.number(),
        bars: z.array(z.object({ day: z.number(), seconds: z.number() })),
        weekMinutes: z.number(),
        weekLessons: z.number(),
        mostActiveWeekday: z.number().nullable(),
      }),
      minutes: z.number(),
      lessons: z.number(),
      topics: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          mastery: z.number(),
          idle: z.boolean(),
          exercisesSolved: z.number(),
          lessons: z.number(),
          lastStudied: z.number().nullable(),
        }),
      ),
    }),
  },
  // Records a finished activity the renderer owns; quizzes, the diagnostic and simulations record themselves on submit.
  "plans.complete": {
    input: z.object({
      planId: z.string(),
      activity: z.enum(["intro", "lesson", "practice", "cards"]),
      topicId: z.string().nullable(),
      result: StepResult.optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  },
  "plans.build": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        jobId: z.string(),
        state: JobState,
        progress: z.number(),
        stepLabel: z.string().nullable(),
        error: z.string().nullable(),
        steps: z.array(JobStepView),
      })
      .nullable(),
  },
  "plans.intro": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        itemId: z.string(),
        markdown: z.string(),
        passageIds: z.array(z.string()),
        answers: SmartAnswers,
      })
      .nullable(),
  },
  "plans.create": {
    input: z.object({
      title: z.string(),
      subject: z.string().optional(),
      sourceIds: z.array(z.string()),
      examAt: z.number().nullable().optional(),
      target: z.number().min(0.5).max(1).optional(),
      language: z.enum(["it", "en"]).optional(),
      style: z.enum(["read", "practice", "decide"]).optional(),
      topicTitles: z.array(z.string()).optional(),
      // The guided flow's edited tree; used only when sourceIds is empty (PLAN-12).
      draftTopics: z
        .array(
          z.object({
            title: z.string().trim().min(1).max(160),
            summary: z.string().max(1200).optional(),
            subtopics: z.array(z.string().trim().min(1).max(160)).max(30).optional(),
          }),
        )
        .min(1)
        .max(40)
        .optional(),
    }),
    output: z.object({
      planId: z.string(),
      jobId: z.string().optional(),
      topics: z.number(),
      pathNodes: z.number(),
    }),
  },
  "plans.proposeModules": {
    input: guidedContext,
    output: z.object({
      modules: z.array(z.object({ title: z.string(), summary: z.string() })),
    }),
  },
  "plans.proposeTree": {
    input: guidedContext.extend({
      style: z.enum(["read", "practice", "decide"]),
      modules: z
        .array(
          z.object({
            title: z.string().min(1).max(160),
            summary: z.string().max(600),
            focus: z.boolean(),
          }),
        )
        .min(1)
        .max(12),
    }),
    output: z.object({
      topics: z.array(
        z.object({
          title: z.string(),
          summary: z.string(),
          subtopics: z.array(z.string()),
        }),
      ),
    }),
  },
  "plans.rebuildState": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        jobId: z.string(),
        state: JobState,
        progress: z.number(),
        stepLabel: z.string().nullable(),
        error: z.string().nullable(),
        steps: z.array(JobStepView),
        /** Present once the job succeeded: what applying would change. */
        review: z
          .object({
            stale: z.boolean(),
            kept: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                /** The title the rebuilt tree gave this topic, which it does not take. */
                newTitle: z.string().optional(),
                reason: z.enum(["passages", "title"]),
                score: z.number(),
              }),
            ),
            added: z.array(
              z.object({ title: z.string(), passages: z.number() }),
            ),
            archived: z.array(
              z.object({
                id: z.string(),
                title: z.string(),
                progress: z.boolean(),
              }),
            ),
          })
          .nullable(),
      })
      .nullable(),
  },
  "plans.rebuildStart": {
    input: z.object({ planId: z.string() }),
    output: z.object({ jobId: z.string() }),
  },
  "plans.rebuildApply": {
    input: z.object({ planId: z.string(), jobId: z.string() }),
    output: z.object({
      kept: z.number(),
      added: z.number(),
      archived: z.number(),
    }),
  },
  "plans.rebuildDiscard": {
    input: z.object({ planId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  "plans.education": {
    input: z.object({ planId: z.string() }),
    output: z.object({ level: EducationLevelSchema.nullable() }),
  },
  "plans.setEducation": {
    input: z.object({ planId: z.string(), level: EducationLevelSchema }),
    output: z.object({ level: EducationLevelSchema }),
  },
  "profile.get": {
    input: z.object({}),
    output: z
      .object({
        displayName: z.string(),
        educationLevel: z.enum([
          "primary",
          "lower-secondary",
          "upper-secondary",
          "technical",
          "vocational",
          "university",
          "other",
        ]),
        year: z.string(),
        school: z.string(),
        course: z.string(),
        tutorMode: z.enum(["solver", "socratic"]),
        contentLanguage: z.string(),
        interests: z.array(z.string()),
        interestsOn: z.boolean(),
        followups: z.boolean(),
        dyslexia: z.boolean(),
        textSize: z.enum(["sm", "md", "lg"]),
        crashReports: z.boolean(),
      })
      .nullable(),
  },
  "profile.save": {
    input: z.object({
      displayName: z.string().optional(),
      educationLevel: z
        .enum([
          "primary",
          "lower-secondary",
          "upper-secondary",
          "technical",
          "vocational",
          "university",
          "other",
        ])
        .optional(),
      year: z.string().optional(),
      school: z.string().optional(),
      course: z.string().optional(),
      tutorMode: z.enum(["solver", "socratic"]).optional(),
      contentLanguage: z.string().optional(),
      interests: z.array(z.string()).optional(),
      interestsOn: z.boolean().optional(),
      followups: z.boolean().optional(),
      dyslexia: z.boolean().optional(),
      textSize: z.enum(["sm", "md", "lg"]).optional(),
      crashReports: z.boolean().optional(),
    }),
    output: z.object({
      displayName: z.string(),
      educationLevel: z.string(),
      year: z.string(),
      school: z.string(),
      course: z.string(),
      tutorMode: z.enum(["solver", "socratic"]),
      contentLanguage: z.string(),
      interests: z.array(z.string()),
      interestsOn: z.boolean(),
      followups: z.boolean(),
      dyslexia: z.boolean(),
      textSize: z.enum(["sm", "md", "lg"]),
      crashReports: z.boolean(),
    }),
  },
  "sources.list": {
    input: z.object({}),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        kind: z.string(),
        status: z.string(),
        blobSha: z.string().nullable(),
        bytes: z.number().nullable(),
        sections: z.number().int().nonnegative(),
        planCount: z.number().int().nonnegative(),
        /** Sections a stored comparison flags as off the syllabus of the plans that use the source. Absent when none or not yet compared. */
        syllabusOff: z.number().int().positive().optional(),
      }),
    ),
  },
  "sources.import": {
    input: z.object({ path: z.string() }),
    output: z.object({
      sourceId: z.string(),
      jobId: z.string().optional(),
      title: z.string(),
      chapters: z.number(),
      passages: z.number(),
      exercises: z.number(),
    }),
  },
  "sources.search": {
    input: z.object({ query: z.string() }),
    output: z.array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        text: z.string(),
        sectionPath: z.string().nullable(),
        locator: z.object({
          chapter: z.number().optional(),
          paragraph: z.string().optional(),
        }),
      }),
    ),
  },
  "sources.chapters": {
    input: z.object({ sourceId: z.string() }),
    output: z.array(z.object({ number: z.number(), title: z.string() })),
  },
  "sources.meta": {
    input: z.object({ sourceId: z.string() }),
    output: z
      .object({
        title: z.string(),
        authors: z.array(z.string()),
        version: z.string().nullable(),
        specVersion: z.string().nullable(),
        knownSpec: z.boolean(),
        /** For a photo: whether the vision engine or local OCR read it. */
        extractor: z
          .object({
            path: z.enum(["vision", "ocr"]),
            provider: z.string().optional(),
            model: z.string().optional(),
            after: z.string().optional(),
            /** For a vision read: the image the model got, and what it was resized from. */
            sent: z
              .object({
                mediaType: z.string(),
                bytes: z.number(),
                width: z.number().optional(),
                height: z.number().optional(),
                resizedFrom: z
                  .object({
                    width: z.number(),
                    height: z.number(),
                    bytes: z.number(),
                  })
                  .optional(),
                /** The EXIF orientation that was applied to the copy sent. */
                orientation: z.number().optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .nullable(),
  },
  "chats.rename": {
    input: z.object({ chatId: z.string(), title: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "chats.delete": {
    input: z.object({ chatId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "chats.regenerate": {
    input: z.object({
      chatId: z.string(),
      sourceIds: z.array(z.string()).optional(),
      planId: z.string().nullable().optional(),
      mode: z.enum(["solver", "socratic"]).optional(),
      allowGeneral: z.boolean().optional(),
      subject: z.string().optional(),
      files: z.array(z.string()).optional(),
    }),
    output: z.object({
      chatId: z.string(),
      covered: z.boolean(),
      skippedImages: z
        .array(z.enum(["too-large", "unreadable", "over-limit"]))
        .optional(),
    }),
  },
  "chats.rate": {
    input: z.object({
      messageId: z.string(),
      reaction: z.enum(["up", "down"]),
    }),
    output: z.object({ reaction: z.enum(["up", "down"]).nullable() }),
  },
  "chats.list": {
    input: z.object({}),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        updatedAt: z.number(),
      }),
    ),
  },
  "chats.read": {
    input: z.object({ chatId: z.string() }),
    output: z.object({
      sourceIds: z.array(z.string()),
      planId: z.string().nullable(),
      subject: z.string().nullable(),
      context: z
        .object({
          kind: z.enum(["answer", "passage"]),
          title: z.string(),
          body: z.string(),
        })
        .nullable(),
      held: z.array(z.object({ id: z.string(), title: z.string() })),
      messages: z.array(
        z.object({
          id: z.string(),
          role: z.enum(["user", "assistant"]),
          checks: z.array(anchoredCheckSchema).optional(),
          body: z.string(),
          modelId: z.string().nullable(),
          provider: z.string().nullable(),
          grounding: z.enum(["sources", "general"]).nullable(),
          followups: z.array(z.string()),
          reaction: z.enum(["up", "down"]).nullable(),
          stopped: z.boolean(),
          citations: z.array(
            z.object({
              label: z.string(),
              index: z.number(),
              passageId: z.string(),
              sourceId: z.string(),
              sectionPath: z.string().nullable(),
              locator: z.object({
                chapter: z.number().optional(),
                paragraph: z.string().optional(),
                page: z.number().optional(),
                slide: z.number().optional(),
              }),
            }),
          ),
        }),
      ),
    }),
  },
  "chats.seed": {
    input: z.object({
      kind: z.enum(["answer", "passage"]),
      title: z.string(),
      body: z.string(),
      sourceIds: z.array(z.string()).optional(),
      planId: z.string().optional(),
      subject: z.string().optional(),
    }),
    output: z.object({ chatId: z.string() }),
  },
  "chats.clearContext": {
    input: z.object({ chatId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "chats.ask": {
    input: z.object({
      chatId: z.string().optional(),
      text: z.string(),
      sourceIds: z.array(z.string()).optional(),
      planId: z.string().nullable().optional(),
      mode: z.enum(["solver", "socratic"]).optional(),
      allowGeneral: z.boolean().optional(),
      subject: z.string().optional(),
      files: z.array(z.string()).optional(),
    }),
    output: z.object({
      chatId: z.string(),
      covered: z.boolean(),
      message: z
        .object({
          id: z.string(),
          role: z.enum(["user", "assistant"]),
          checks: z.array(anchoredCheckSchema).optional(),
          body: z.string(),
          modelId: z.string().nullable(),
          provider: z.string().nullable(),
          grounding: z.enum(["sources", "general"]).nullable(),
          followups: z.array(z.string()),
          citations: z.array(
            z.object({
              label: z.string(),
              index: z.number(),
              passageId: z.string(),
              sourceId: z.string(),
              sectionPath: z.string().nullable(),
              locator: z.object({
                chapter: z.number().optional(),
                paragraph: z.string().optional(),
                page: z.number().optional(),
                slide: z.number().optional(),
              }),
            }),
          ),
        })
        .nullable(),
      /** Saved images the reply did not see, with why. */
      skippedImages: z
        .array(z.enum(["too-large", "unreadable", "over-limit"]))
        .optional(),
    }),
  },
  "sources.ocr": {
    input: z.object({ sourceId: z.string() }),
    output: z.object({ status: z.literal("ocr-queued") }),
  },
  "sources.paste": {
    input: z.object({ title: z.string(), text: z.string() }),
    output: z.object({
      sourceId: z.string(),
      jobId: z.string().optional(),
      title: z.string(),
      chapters: z.number(),
      passages: z.number(),
      exercises: z.number(),
    }),
  },
  "sources.linkPreview": {
    input: z.object({ url: z.string().url().max(4000) }),
    output: z.object({
      title: z.string(),
      excerpt: z.string(),
      kind: z.enum(["pdf", "web"]),
      bytes: z.number().nullable(),
    }),
  },
  "sources.link": {
    input: z.object({ url: z.string() }),
    output: z.object({
      sourceId: z.string(),
      jobId: z.string().optional(),
      title: z.string(),
      chapters: z.number(),
      passages: z.number(),
      exercises: z.number(),
    }),
  },
  "sources.scanFolder": {
    input: z.object({ path: z.string() }),
    output: z.object({
      files: z.array(
        z.object({ path: z.string(), name: z.string(), duplicate: z.boolean() }),
      ),
      /** More importable files exist than the `limit` listed. */
      cappedFiles: z.boolean(),
      /** Subfolders nested too deep were not read. */
      cappedDepth: z.boolean(),
      /** Subfolders that could not be read were skipped. */
      unreadable: z.boolean(),
      limit: z.number(),
    }),
  },
  "sources.preview": {
    input: z.object({ path: z.string() }),
    output: z.object({
      duplicate: z.boolean(),
      blurry: z.boolean(),
      /** The newest usable source with the same file. Importing it again would only make a second copy. */
      existingSourceId: z.string().optional(),
    }),
  },
  "sources.rename": {
    input: z.object({ sourceId: z.string(), title: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "sources.replace": {
    input: z.object({ sourceId: z.string(), path: z.string() }),
    output: z.object({
      sourceId: z.string(),
      jobId: z.string().optional(),
      title: z.string(),
      chapters: z.number(),
      passages: z.number(),
      exercises: z.number(),
    }),
  },
  "sources.syllabus": {
    input: z.object({ sourceId: z.string() }),
    output: z.array(
      z.object({
        planId: z.string(),
        planTitle: z.string(),
        state: z.enum(["checked", "unavailable", "unindexed", "no-context"]),
        sections: z.number(),
        off: z.number(),
        worst: z.array(z.object({ section: z.string(), similarity: z.number() })),
      }),
    ),
  },
  "sources.reextract": {
    input: z.object({ sourceId: z.string(), confirmed: z.boolean() }),
    output: z.object({
      started: z.boolean(),
      /** Plans that use the source. Above zero and unconfirmed, nothing started. */
      inUse: z.number(),
      jobId: z.string().optional(),
    }),
  },
  "sources.remove": {
    input: z.object({ sourceId: z.string(), confirmed: z.boolean() }),
    output: z.object({ removed: z.boolean(), inUse: z.boolean() }),
  },
  "sources.promote": {
    input: z.object({ sourceId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Stops a scan the renderer cannot finish. The source goes back to `needs-ocr`, its pages kept. Never throws for a source that is not queued. */
  "sources.ocrStop": {
    input: z.object({ sourceId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "sources.ocrImage": {
    input: z.object({
      sourceId: z.string(),
      pngBase64: z.string().max(MAX_IMAGE_BASE64),
      page: z.number(),
      last: z.boolean(),
    }),
    output: z.object({ status: z.enum(["ready", "failed", "ocr-queued"]) }),
  },
  /**
   * Local OCR language data (English and Italian, one pinned download). Disk truth: `ready` only when every file matches
   * its pinned hash, `integrity` when a file is there but altered or cut short, `missing` otherwise. `consent` is the
   * student's saved answer to the download; nothing is fetched without it.
   */
  "sources.ocrDataState": {
    input: z.object({}),
    output: z.object({
      consent: z.boolean(),
      state: z.enum(["ready", "missing", "integrity"]),
      totalBytes: z.number(),
      languages: z.array(z.string()),
      /** The download job while it is queued or running, so a reopened screen can show its progress. */
      jobId: z.string().optional(),
    }),
  },
  /** Saves the consent. `true` starts, or re-attaches to, the `ocr-data-download` job (cancel and retry are the job's). */
  "sources.ocrData": {
    input: z.object({ consent: z.boolean() }),
    output: z.object({
      state: z.enum(["off", "ready", "missing"]),
      jobId: z.string().optional(),
    }),
  },
  "sources.embedState": {
    input: z.object({}),
    output: z.object({ consent: z.boolean(), ready: z.boolean() }),
  },
  "sources.embed": {
    input: z.object({ consent: z.boolean() }),
    output: z.object({
      state: z.enum(["off", "ready", "missing"]),
      jobId: z.string().optional(),
    }),
  },
  "sources.passage": {
    input: z.object({ passageId: z.string() }),
    output: z.array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        text: z.string(),
        sectionPath: z.string().nullable(),
        locator: z.object({
          chapter: z.number().optional(),
          paragraph: z.string().optional(),
          page: z.number().optional(),
          slide: z.number().optional(),
        }),
        current: z.boolean(),
      }),
    ),
  },
  "sources.viewerDocument": {
    input: z
      .object({
        sourceId: z.string().optional(),
        passageId: z.string().optional(),
      })
      .refine((v) => Boolean(v.sourceId || v.passageId)),
    output: z
      .object({
        sourceId: z.string(),
        title: z.string(),
        kind: z.string(),
        blobSha: z.string().nullable(),
        excerpt: z.string().nullable(),
      })
      .nullable(),
  },
  "sources.chapter": {
    input: z.object({
      sourceId: z.string(),
      chapter: z.number(),
      paragraph: z.string().optional(),
    }),
    output: z.array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        text: z.string(),
        sectionPath: z.string().nullable(),
        locator: z.object({
          chapter: z.number().optional(),
          paragraph: z.string().optional(),
          page: z.number().optional(),
          slide: z.number().optional(),
        }),
        current: z.boolean(),
      }),
    ),
  },
} as const;

export const streams = {} as const;

export const broadcasts = {
  "job.updated": JobView,
  // Background recomputation of automatic engine choices finished.
  "engine.auto": z.object({}),
  "engine.login": z.object({
    provider: z.string(),
    type: z.string(),
    url: z.string().optional(),
    message: z.string().optional(),
    command: z.array(z.string()).optional(),
  }),
} as const;

export type RequestName = keyof typeof requests;
export type BroadcastName = keyof typeof broadcasts;

export type RequestInput<N extends RequestName> = z.infer<
  (typeof requests)[N]["input"]
>;
export type RequestOutput<N extends RequestName> = z.infer<
  (typeof requests)[N]["output"]
>;
export type BroadcastValue<N extends BroadcastName> = z.infer<
  (typeof broadcasts)[N]
>;

export type PortRequest = {
  kind: "req";
  id: string;
  name: string;
  input: unknown;
};

export type PortResponse = {
  kind: "res";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: IpcErrorBody;
};

export type PortStream = { kind: "stream"; id: string; event: unknown };
export type PortEnd = { kind: "end"; id: string };
export type PortCancel = { kind: "cancel"; id: string };
export type PortBroadcast = { kind: "bcast"; name: string; value: unknown };

export type PortMessage =
  | PortRequest
  | PortResponse
  | PortStream
  | PortEnd
  | PortCancel
  | PortBroadcast;
