import { IpcError, isAbort } from "../../shared/ipc";
import { DISCLOSURE_REQUIRED } from "./disclosure";
import { FunnelError } from "./funnel";

export type EngineMessage = {
  messageKey: string;
  code: string;
};

/** Codes CLI Funnel attaches to stream errors as well as to FunnelError. */
const funnelCodes = new Set([
  "not-installed",
  "not-logged-in",
  "unsupported",
  "invalid-selection",
  "aborted",
  // The connection closed before the answer finished (CLI Funnel 0.5.0 reports it instead of a short answer).
  "stream-truncated",
]);

/** True when CLI Funnel attached a rate or quota `limit` to the failure. */
function hasLimit(err: unknown): boolean {
  return !!err && typeof err === "object" && "limit" in err && !!err.limit;
}

/**
 * The HTTP status a failure text states, or 0. A bare number is not one: a line number, a port or a process id
 * must not read as "signed out" or "usage limit". The status has to follow a word that introduces it (`HTTP 401`,
 * `status code 429`, `returned 401`, `error: 429`) or sit after a provider label at the start (`OpenAI 401: ...`).
 */
function httpStatus(message: string): number {
  const stated =
    /\b(?:http(?:\/[\d.]+)?|status(?: code)?|returned|error|code)[\s:=]+([1-5]\d\d)\b/i.exec(
      message,
    ) ?? /^[A-Za-z][\w .-]{0,40}?\s([1-5]\d\d)(?=[:.])/.exec(message);
  return stated ? Number(stated[1]) : 0;
}

/**
 * Classifies a failure by its text when it carries no structured code or limit: the status it states first, then
 * whole words. Stderr goes through here too, so every pattern is anchored to a word or a stated status.
 */
function textKind(
  rawCode: string,
  message: string,
): "refused" | "quota" | "model" | "" {
  const status =
    httpStatus(message) || (/^[1-5]\d\d$/.test(rawCode) ? Number(rawCode) : 0);
  if (status === 401) return "refused";
  if (status === 429) return "quota";
  const text = `${rawCode} ${message}`;
  // A subscription that leaves out the chosen model, which the engine's other models may still have. Cursor says "is
  // not included in your weekly usage. Buy credits or switch to a Grok model". Read before the limits below, because
  // the same message offers credits.
  if (
    /\b(?:not included in your (?:plan|subscription|weekly usage|usage)|upgrade your (?:plan|subscription) to use)\b/i.test(
      text,
    )
  )
    return "model";
  if (
    /\b(?:invalid[ _-]api[ _-]key|unauthori[sz]ed|authentication(?:[ _-](?:error|failed|required))?)\b/i.test(
      text,
    )
  )
    return "refused";
  if (
    /\b(?:rate[ _-]limit(?:ed|[ _-]exceeded)?|too many requests|usage[ _-]limit|spend[ _-]limit|(?:insufficient[ _-])?quota|out of credits|insufficient credits|buy (?:more )?credits)\b/i.test(
      text,
    )
  )
    return "quota";
  return "";
}

/**
 * Maps a funnel or vendor failure to a translated key. The raw text stays in `detail`. A refused login on a CLI engine
 * means its sign-in expired, not that an API key is wrong: students on a subscription have no key.
 */
export function translateEngineError(
  err: unknown,
  provider?: string,
): EngineMessage {
  const message = err instanceof Error ? err.message : String(err);
  const rawCode =
    err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (message === DISCLOSURE_REQUIRED) {
    return {
      code: "disclosure-required",
      messageKey: "engines.errors.disclosure-required",
    };
  }
  // CLI Funnel attaches the limit a provider reported to the error. That is firmer than any wording in the text.
  if (hasLimit(err))
    return { code: "quota", messageKey: "engines.errors.quota" };
  if (funnelCodes.has(rawCode))
    return { code: rawCode, messageKey: `engines.errors.${rawCode}` };
  const kind = textKind(rawCode, message);
  if (kind === "refused") {
    return provider && !provider.endsWith("-api")
      ? { code: "not-logged-in", messageKey: "engines.errors.not-logged-in" }
      : { code: "refused", messageKey: "engines.errors.refused" };
  }
  if (kind === "quota")
    return { code: "quota", messageKey: "engines.errors.quota" };
  if (kind === "model")
    return {
      code: "model-not-included",
      messageKey: "engines.errors.model-not-included",
    };
  const code = err instanceof FunnelError ? err.code : "cli-failed";
  return { code, messageKey: `engines.errors.${code}` };
}

/**
 * Why another engine could answer instead: the engine hit a usage limit (CLI Funnel attaches the `limit` it reported to
 * the error), its sign-in or key was refused, or the subscription does not include the model. Any other failure is not
 * one a second engine would get round.
 */
export function fallbackReason(
  err: unknown,
  provider: string,
): "limit" | "signed-out" | "model" | undefined {
  if (!isEngineFailure(err) && !(err instanceof Error && "limit" in err))
    return undefined;
  if (err && typeof err === "object" && "limit" in err && err.limit)
    return "limit";
  const { code } = translateEngineError(err, provider);
  if (code === "quota") return "limit";
  if (code === "not-logged-in" || code === "refused") return "signed-out";
  if (code === "model-not-included") return "model";
  return undefined;
}

/** Node error codes of a lost connection, which a CLI or API provider reports as a plain error with a `code`. */
const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True for a failure of the engine itself: CLI Funnel's own errors (also the plain errors it builds from a stream, which
 * carry its `code`) and a lost connection. Anything else, such as a reply that cannot be used or a bug in Pyxis, is not
 * an engine problem and keeps its own message.
 */
function isEngineFailure(err: unknown): boolean {
  if (err instanceof FunnelError) return true;
  if (!err || typeof err !== "object" || !("code" in err)) return false;
  const code = String(err.code);
  return (
    funnelCodes.has(code) || code === "cli-failed" || networkCodes.has(code)
  );
}

/**
 * The error a model call surfaces to the screen. A failed engine becomes an IpcError carrying the translated
 * `engines.errors.*` key and the raw text as detail. A cancelled call, an error that already is an IpcError (such as
 * `invalid-output`) and an error that is not the engine's pass through unchanged, so each feature keeps its own message
 * for a reply it cannot use. A refused notice keeps the `engine-disclosure-required` code, which background jobs and
 * photo imports match on.
 */
export function engineIpcError(err: unknown, provider?: string): unknown {
  if (err instanceof IpcError || isAbort(err)) return err;
  if (err && typeof err === "object" && "code" in err && err.code === "aborted")
    return err;
  if (err instanceof Error && err.message.startsWith("engine-disclosure")) {
    return new IpcError(err.message, "engines.errors.disclosure-required");
  }
  if (!isEngineFailure(err)) return err;
  const translated = translateEngineError(err, provider);
  return new IpcError(
    translated.code,
    translated.messageKey,
    {},
    err instanceof Error ? err.message : String(err),
  );
}
