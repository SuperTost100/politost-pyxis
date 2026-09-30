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
} as const;

export const streams = {} as const;

export const broadcasts = {
  "job.updated": JobView,
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
