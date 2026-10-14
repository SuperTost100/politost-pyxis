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
 * The error a model call surfaces to the screen: an IpcError carrying the translated `engines.errors.*` key and the raw
 * text as detail. A cancelled call and an error that already is an IpcError pass through unchanged. A refused notice keeps
 * the `engine-disclosure-required` code, which background jobs and photo imports match on.
 */
export function engineIpcError(err: unknown, provider?: string): unknown {
  if (err instanceof IpcError || isAbort(err)) return err;
  if (err && typeof err === "object" && "code" in err && err.code === "aborted")
    return err;
  if (err instanceof Error && err.message.startsWith("engine-disclosure")) {
    return new IpcError(
      err.message,
      "engines.errors.disclosure-required",
    );
  }
  const translated = translateEngineError(err, provider);
  return new IpcError(
    translated.code,
    translated.messageKey,
    {},
    err instanceof Error ? err.message : String(err),
  );
}
