import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Debug mode's log: one JSON-lines file per job, `<workspace>/logs/jobs/<job id>.jsonl`, written only while the switch
 * "Show technical details and debug" is on. Each AI call adds a `call` line (which AI, model and access, the prompt),
 * the engine's events, then an `end` line with how long it took. Keys and tokens are masked before a line is written,
 * the files stay on this computer, and nothing reads them but the job details in Attività.
 */

const MASK = "[redacted]";
const SECRET_NAMES =
  "api[-_]?key|x-api-key|authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|token|(?:access|refresh|id|auth|session|bearer)[-_]?token";
const SECRET_JSON_FIELD = new RegExp(`("(?:${SECRET_NAMES})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, "gi");
const SECRET_FIELD = new RegExp(`^(?:${SECRET_NAMES})$`, "i");
const ENV_SECRET = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const AUTH_HEADER =
  /\b(authorization|proxy-authorization|x-api-key)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;}]+/gi;

type Redact = (text: string, secrets?: (string | undefined)[]) => string;
// cli-funnel's `redact`. Only the engine module imports cli-funnel, so it hands the function over when it loads; until
// then the log writes nothing, so no line can go out unmasked.
let redact: Redact | null = null;
export function setRedact(next: Redact): void {
  redact = next;
}

/** Masks keys and tokens in text: cli-funnel's `redact`, then secret JSON fields, KEY=value pairs and auth headers. */
export function redactText(text: string, secrets: (string | undefined)[] = []): string {
  if (!redact) throw new Error("debug-log-unmasked");
  return (
    redact(text, secrets)
      // JSON fields first: the patterns for environment values and headers stop at a space or an escaped quote.
      .replace(SECRET_JSON_FIELD, `$1"${MASK}"`)
      .replace(ENV_SECRET, `$1=${MASK}`)
      .replace(AUTH_HEADER, `$1$2${MASK}`)
  );
}

/** `redactText` on every string of a value. A field named like a secret, and every value under `env` or `headers`, is masked whole. */
export function redactValue(value: unknown, secrets: (string | undefined)[] = [], key = ""): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    const hide = key === "env" || key === "headers";
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => [
        name,
        hide || SECRET_FIELD.test(name) ? MASK : redactValue(field, secrets, name),
      ]),
    );
  }
  return value;
}

/** A job log past this size gets one `log.capped` line and nothing more, so a runaway job cannot fill the disk. */
export const JOB_LOG_MAX = 20 * 1024 * 1024;
/** How much of one log the job details read back. The file keeps the rest. */
export const JOB_LOG_READ_MAX = 2 * 1024 * 1024;
/** One text field in a line: a prompt or a reply longer than this is cut, with its full length noted. */
export const FIELD_MAX = 20_000;

export type CallLine = {
  type: "call";
  at: string;
  id: string;
  provider: string;
  model: string;
  access: "subscription" | "api-key" | "local";
  kind?: string;
  prompt: string;
  system?: string;
};
export type EndLine = {
  type: "end";
  at: string;
  id: string;
  ms: number;
  text: string;
  textLength: number;
  finishReason?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
};
export type EventLine = { type: "event"; at: string; id: string; event: unknown };
export type CappedLine = { type: "log.capped"; at: string; bytes: number };
export type LogLine = CallLine | EndLine | EventLine | CappedLine;

let root = "";
let on = false;
const sizes = new Map<string, number>();
// Writes go one after another, so the lines of one file never interleave, and a failed write never reaches the job.
let queue: Promise<void> = Promise.resolve();

/** Core sets the log folder once a workspace is open. Without it nothing is written. */
export function setDebugLogRoot(path: string): void {
  root = path;
  sizes.clear();
}

export function setDebugOn(next: boolean): void {
  on = next;
}

export function debugOn(): boolean {
  return on && root !== "" && redact !== null;
}

/** Job ids are uuids; anything else could name a path outside the folder. */
function fileFor(jobId: string): string | null {
  if (!root || !/^[A-Za-z0-9-]{1,64}$/.test(jobId)) return null;
  return join(root, "jobs", `${jobId}.jsonl`);
}

export function jobLogPath(jobId: string): string | null {
  return fileFor(jobId);
}

function cut(text: string): string {
  return text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX)}… [${text.length} characters]` : text;
}

function write(jobId: string, line: LogLine): void {
  const file = fileFor(jobId);
  if (!file) return;
  const body = `${JSON.stringify(redactValue(line))}\n`;
  queue = queue.then(async () => {
    try {
      let size = sizes.get(file);
      if (size === undefined) size = await stat(file).then((info) => info.size, () => 0);
      if (size >= JOB_LOG_MAX) return;
      const capped = size + Buffer.byteLength(body) > JOB_LOG_MAX;
      const text = capped
        ? `${JSON.stringify({ type: "log.capped", at: new Date().toISOString(), bytes: size } satisfies CappedLine)}\n`
        : body;
      await mkdir(join(root, "jobs"), { recursive: true, mode: 0o700 });
      await appendFile(file, text, { mode: 0o600 });
      sizes.set(file, capped ? JOB_LOG_MAX : size + Buffer.byteLength(text));
    } catch (err) {
      console.warn("debug log: a line could not be written", err instanceof Error ? err.message : err);
    }
  });
}

/** Waits for the lines written so far. Tests and the log reader use it. */
export function flushDebugLog(): Promise<void> {
  return queue;
}

let next = 0;

/**
 * Starts one AI call's record in a job's log. The returned handle takes the engine's events and the end. A call made
 * while debug mode is off, or outside a job, gets null and costs nothing.
 */
export function startCall(
  jobId: string | undefined,
  call: Omit<CallLine, "type" | "at" | "id">,
  now = Date.now(),
): { event(event: { type: string }): void; end(end: Omit<EndLine, "type" | "at" | "id" | "ms" | "textLength">): void } | null {
  if (!jobId || !debugOn()) return null;
  const id = `${now.toString(36)}-${(next++).toString(36)}`;
  const started = now;
  write(jobId, {
    type: "call",
    at: new Date(now).toISOString(),
    id,
    ...call,
    prompt: cut(call.prompt),
    ...(call.system ? { system: cut(call.system) } : {}),
  });
  return {
    event(event) {
      // The streamed text comes once, whole, in the end line.
      if (event.type === "text.delta") return;
      write(jobId, { type: "event", at: new Date().toISOString(), id, event });
    },
    end(end) {
      write(jobId, {
        type: "end",
        at: new Date().toISOString(),
        id,
        ms: Date.now() - started,
        ...end,
        text: cut(end.text),
        textLength: end.text.length,
      });
    },
  };
}

/** The job's log as lines, newest kept when the file is longer than the read limit. Null when there is none. */
export async function readJobLog(jobId: string): Promise<{ lines: LogLine[]; text: string; truncated: boolean } | null> {
  const file = fileFor(jobId);
  if (!file) return null;
  await flushDebugLog();
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  const truncated = raw.length > JOB_LOG_READ_MAX;
  const text = truncated ? raw.slice(raw.indexOf("\n", raw.length - JOB_LOG_READ_MAX) + 1) : raw;
  const lines = text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LogLine];
      } catch {
        // A line cut by a crash mid-write is left out.
        return [];
      }
    });
  return { lines, text, truncated };
}

/** Deletes a job's log, with the job. */
export async function removeJobLog(jobId: string): Promise<void> {
  const file = fileFor(jobId);
  if (!file) return;
  await flushDebugLog();
  sizes.delete(file);
  await rm(file, { force: true });
}

/** The most events one call carries to the job details. The copied log keeps them all. */
export const EVENTS_SHOWN = 200;

export type CallView = {
  id: string;
  at: string;
  provider: string;
  model: string;
  access: CallLine["access"];
  kind?: string;
  prompt: string;
  system?: string;
  ms: number | null;
  text: string | null;
  textLength: number | null;
  finishReason?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  events: Array<{ at: string; event: unknown }>;
  eventCount: number;
};

/** Folds a log's lines into its calls, in the order they started. A call still running has no end yet. */
export function callsOf(lines: LogLine[]): { calls: CallView[]; capped: boolean } {
  const calls = new Map<string, CallView>();
  let capped = false;
  for (const line of lines) {
    if (line.type === "log.capped") {
      capped = true;
      continue;
    }
    if (line.type === "call") {
      calls.set(line.id, {
        id: line.id,
        at: line.at,
        provider: line.provider,
        model: line.model,
        access: line.access,
        ...(line.kind ? { kind: line.kind } : {}),
        prompt: line.prompt,
        ...(line.system ? { system: line.system } : {}),
        ms: null,
        text: null,
        textLength: null,
        events: [],
        eventCount: 0,
      });
      continue;
    }
    const call = calls.get(line.id);
    if (!call) continue;
    if (line.type === "event") {
      call.eventCount += 1;
      if (call.events.length < EVENTS_SHOWN) call.events.push({ at: line.at, event: line.event });
    } else {
      call.ms = line.ms;
      call.text = line.text;
      call.textLength = line.textLength;
      if (line.finishReason) call.finishReason = line.finishReason;
      if (line.error) call.error = line.error;
      if (line.inputTokens !== undefined) call.inputTokens = line.inputTokens;
      if (line.outputTokens !== undefined) call.outputTokens = line.outputTokens;
    }
  }
  return { calls: [...calls.values()], capped };
}
