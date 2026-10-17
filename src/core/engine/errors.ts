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
]);

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
  if (funnelCodes.has(rawCode))
    return { code: rawCode, messageKey: `engines.errors.${rawCode}` };
  if (/401|invalid api key|authentication/i.test(`${rawCode} ${message}`)) {
    return provider && !provider.endsWith("-api")
      ? { code: "not-logged-in", messageKey: "engines.errors.not-logged-in" }
      : { code: "refused", messageKey: "engines.errors.refused" };
  }
  if (
    /429|rate limit|usage limit|spend limit|quota/i.test(
      `${rawCode} ${message}`,
    )
  ) {
    return { code: "quota", messageKey: "engines.errors.quota" };
  }
  const code = err instanceof FunnelError ? err.code : "cli-failed";
  return { code, messageKey: `engines.errors.${code}` };
}

/**
 * Why another engine could answer instead: the engine hit a usage limit (CLI Funnel attaches the `limit` it reported to
 * the error) or its sign-in or key was refused. Any other failure is not one a second engine would get round.
 */
export function fallbackReason(
  err: unknown,
  provider: string,
): "limit" | "signed-out" | undefined {
  if (!isEngineFailure(err) && !(err instanceof Error && "limit" in err))
    return undefined;
  if (err && typeof err === "object" && "limit" in err && err.limit)
    return "limit";
  const { code } = translateEngineError(err, provider);
  if (code === "quota") return "limit";
  if (code === "not-logged-in" || code === "refused") return "signed-out";
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
