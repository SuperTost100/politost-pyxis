import { z } from "zod";

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
  "sources.list": {
    input: z.object({}),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        kind: z.string(),
        status: z.string(),
      }),
    ),
  },
  "sources.import": {
    input: z.object({ path: z.string() }),
    output: z.object({
      sourceId: z.string(),
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
  "sources.chapter": {
    input: z.object({
      sourceId: z.string(),
      chapter: z.number(),
      paragraph: z.string().optional(),
    }),
    output: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        sectionPath: z.string().nullable(),
        locator: z.object({ chapter: z.number(), paragraph: z.string() }),
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
