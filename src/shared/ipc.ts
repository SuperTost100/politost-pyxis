import { z } from "zod";
import { planFileSchema } from "./plan-file";

const mapNode = z.object({
  id: z.string(),
  label: z.string(),
  parent: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  pinned: z.boolean(),
  color: z.string().optional(),
});
const mapEdge = z.object({ from: z.string(), to: z.string() });
const conceptGraph = z.object({
  layout: z.enum(["tree", "radial"]),
  nodes: z.array(mapNode),
  edges: z.array(mapEdge),
  undo: z.object({ nodes: z.array(mapNode), edges: z.array(mapEdge) }).nullable(),
});
const mapOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    id: z.string(),
    label: z.string(),
    parent: z.string(),
  }),
  z.object({ op: z.literal("rename"), id: z.string(), label: z.string() }),
  z.object({ op: z.literal("delete"), id: z.string() }),
  z.object({ op: z.literal("connect"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("disconnect"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("recolor"), id: z.string(), color: z.string() }),
]);

export const JobState = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

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
      }),
    ),
  },
  "engines.models": {
    input: z.object({ provider: z.string() }),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  "engines.test": {
    input: z.object({
      provider: z.string(),
      model: z.string().optional(),
    }),
    output: z.object({
      ok: z.literal(true),
      latencyMs: z.number(),
      model: z.string(),
      inputTokens: z.number(),
    }),
  },
  "engines.clearFeature": {
    input: z.object({ feature: z.literal("chat") }),
    output: z.object({ ok: z.literal(true) }),
  },
  "engines.setFeature": {
    input: z.object({
      feature: z.enum(["default", "chat", "plan", "lesson", "grading", "map", "vision"]),
      provider: z.string(),
      model: z.string(),
    }),
    output: z.object({ warning: z.string().nullable() }),
  },
  "engines.features": {
    input: z.object({}),
    output: z.record(z.string(), z.object({ provider: z.string(), model: z.string() })),
  },
  "engines.login": {
    input: z.object({ provider: z.string() }),
    output: z.object({
      type: z.string(),
      url: z.string().optional(),
      message: z.string().optional(),
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
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.object({ markdown: z.string(), passageIds: z.array(z.string()) }),
  },
  "study.markdown": {
    input: z.object({
      planId: z.string(),
      kind: z.enum(["lesson", "cards", "quiz", "simulation"]),
      topicId: z.string().optional(),
      answers: z.boolean().optional(),
    }),
    output: z.object({ filename: z.string(), markdown: z.string() }),
  },
  "study.csv": {
    input: z.object({ planId: z.string(), topicId: z.string().optional() }),
    output: z.object({ filename: z.string(), csv: z.string() }),
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
    input: z.object({ planId: z.string(), topicId: z.string() }),
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
  "study.quizSubmit": {
    input: z.object({
      attemptId: z.string(),
      picks: z.record(z.string(), z.string()),
    }),
    output: z.object({
      score: z.number(),
      results: z.array(
        z.object({ id: z.string(), score: z.number(), expected: z.string(), explanation: z.string() }),
      ),
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
    input: z.object({ planId: z.string() }),
    output: z.object({
      cards: z.array(z.object({ id: z.string(), front: z.string(), topicId: z.string().nullable() })),
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
  "study.simulationOpen": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        attemptId: z.string(),
        planId: z.string(),
        deadline: z.number(),
        leftMs: z.number(),
        submitted: z.boolean(),
        questions: z.array(z.object({ id: z.string(), stem: z.string() })),
        picks: z.record(z.string(), z.string()),
        topics: z.array(z.object({ id: z.string(), title: z.string(), score: z.number() })),
      })
      .nullable(),
  },
  "study.simulationStart": {
    input: z.object({
      planId: z.string(),
      minutes: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
      source: z.enum(["exam", "mixed"]).optional(),
    }),
    output: z.object({
      attemptId: z.string(),
      deadline: z.number(),
      questions: z.array(z.object({ id: z.string(), stem: z.string() })),
    }),
  },
  "study.simulationRead": {
    input: z.object({ attemptId: z.string() }),
    output: z.object({
      attemptId: z.string(),
      planId: z.string(),
      deadline: z.number(),
      leftMs: z.number(),
      submitted: z.boolean(),
      questions: z.array(z.object({ id: z.string(), stem: z.string() })),
      picks: z.record(z.string(), z.string()),
      topics: z.array(z.object({ id: z.string(), title: z.string(), score: z.number() })),
    }),
  },
  "study.simulationDraft": {
    input: z.object({
      attemptId: z.string(),
      picks: z.record(z.string(), z.string()),
    }),
    output: z.object({
      attemptId: z.string(),
      planId: z.string(),
      deadline: z.number(),
      leftMs: z.number(),
      submitted: z.boolean(),
      questions: z.array(z.object({ id: z.string(), stem: z.string() })),
      picks: z.record(z.string(), z.string()),
      topics: z.array(z.object({ id: z.string(), title: z.string(), score: z.number() })),
    }),
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
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.array(
      z.object({
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
      }),
    ),
  },
  "study.queue": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: z.object({ fresh: z.number(), learning: z.number(), mastered: z.number() }),
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
    input: z.object({ topicId: z.string() }),
    output: z.array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        answer: z.string().nullable(),
      }),
    ),
  },
  "tools.python": {
    input: z.object({ code: z.string().max(8000) }),
    output: z.object({
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
  "maps.open": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
    output: conceptGraph,
  },
  "maps.layout": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
      layout: z.enum(["tree", "radial"]),
    }),
    output: conceptGraph,
  },
  "maps.move": {
    input: z.object({
      planId: z.string(),
      topicId: z.string(),
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
      ops: z.array(mapOp),
    }),
    output: conceptGraph,
  },
  "maps.undo": {
    input: z.object({ planId: z.string(), topicId: z.string() }),
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
      }),
    ),
  },
  "subjects.list": {
    input: z.object({}),
    output: z.array(z.object({ id: z.string(), name: z.string() })),
  },
  "plans.usage": {
    input: z.object({}),
    output: z.array(z.object({ id: z.string(), title: z.string(), bytes: z.number() })),
  },
  "plans.read": {
    input: z.object({ planId: z.string() }),
    output: z
      .object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        target: z.number(),
        topics: z.array(z.object({ id: z.string(), title: z.string(), position: z.number() })),
        nodes: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            kind: z.string(),
            topicId: z.string().nullable(),
            position: z.number(),
            state: z.enum(["locked", "current", "done"]),
          }),
        ),
        sources: z.array(z.object({ id: z.string(), title: z.string() })),
      })
      .nullable(),
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
    }),
    output: planFileSchema,
  },
  "plans.import": {
    input: planFileSchema,
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
        nodeId: z.string(),
        reason: z.enum(["due", "gaps", "next"]),
        count: z.number(),
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
      chart: z.array(z.object({ day: z.number(), count: z.number(), mastery: z.number() })),
      weeks: z.array(z.number()),
      counts: z.record(z.string(), z.array(z.number())),
      gaps: z.array(z.object({ topicId: z.string(), openedAt: z.number() })),
      pace: z.object({ week: z.number(), peakDay: z.number(), peakCount: z.number() }),
      minutes: z.number(),
      lessons: z.number(),
      topics: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          mastery: z.number(),
          idle: z.boolean(),
        }),
      ),
    }),
  },
  "plans.complete": {
    input: z.object({ planId: z.string(), nodeId: z.string() }),
    output: z.object({ ok: z.boolean() }),
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
    }),
    output: z.object({
      planId: z.string(),
      topics: z.number(),
      pathNodes: z.number(),
    }),
  },
  "plans.rebuild": {
    input: z.object({ planId: z.string(), sourceIds: z.array(z.string()) }),
    output: z.object({ topics: z.number() }),
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
        school: z.string(),
        course: z.string(),
        tutorMode: z.enum(["solver", "socratic"]),
        contentLanguage: z.string(),
        interests: z.array(z.string()),
        interestsOn: z.boolean(),
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
      school: z.string().optional(),
      course: z.string().optional(),
      tutorMode: z.enum(["solver", "socratic"]).optional(),
      contentLanguage: z.string().optional(),
      interests: z.array(z.string()).optional(),
      interestsOn: z.boolean().optional(),
      dyslexia: z.boolean().optional(),
      textSize: z.enum(["sm", "md", "lg"]).optional(),
      crashReports: z.boolean().optional(),
    }),
    output: z.object({
      displayName: z.string(),
      educationLevel: z.string(),
      school: z.string(),
      course: z.string(),
      tutorMode: z.enum(["solver", "socratic"]),
      contentLanguage: z.string(),
      interests: z.array(z.string()),
      interestsOn: z.boolean(),
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
      mode: z.enum(["solver", "socratic"]).optional(),
      allowGeneral: z.boolean().optional(),
      subject: z.string().optional(),
      files: z.array(z.string()).optional(),
    }),
    output: z.object({
      chatId: z.string(),
      covered: z.boolean(),
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
    output: z.array(
      z.object({ path: z.string(), name: z.string(), duplicate: z.boolean() }),
    ),
  },
  "sources.preview": {
    input: z.object({ path: z.string() }),
    output: z.object({ duplicate: z.boolean(), blurry: z.boolean() }),
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
  "sources.remove": {
    input: z.object({ sourceId: z.string(), confirmed: z.boolean() }),
    output: z.object({ removed: z.boolean(), inUse: z.boolean() }),
  },
  "sources.promote": {
    input: z.object({ sourceId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  "sources.ocrImage": {
    input: z.object({
      sourceId: z.string(),
      pngBase64: z.string(),
      page: z.number(),
      last: z.boolean(),
    }),
    output: z.object({ status: z.enum(["ready", "failed", "ocr-queued"]) }),
  },
  "sources.embedState": {
    input: z.object({}),
    output: z.object({ consent: z.boolean(), ready: z.boolean() }),
  },
  "sources.embed": {
    input: z.object({ consent: z.boolean() }),
    output: z.object({ state: z.enum(["off", "ready", "missing"]), jobId: z.string().optional() }),
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
    input: z.object({ sourceId: z.string().optional(), passageId: z.string().optional() })
      .refine((v) => Boolean(v.sourceId || v.passageId)),
    output: z.object({ sourceId: z.string(), title: z.string(), kind: z.string(), blobSha: z.string().nullable(), excerpt: z.string().nullable() }).nullable(),
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
        locator: z.object({ chapter: z.number().optional(), paragraph: z.string().optional(), page: z.number().optional(), slide: z.number().optional() }),
        current: z.boolean(),
      }),
    ),
  },
} as const;

export const streams = {} as const;

export const broadcasts = {
  "job.updated": JobView,
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
