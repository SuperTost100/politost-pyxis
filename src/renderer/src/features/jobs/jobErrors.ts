import { sourceErrorKey } from "../../../../shared/source-errors";
import { ocrErrorKey } from "../../components/ocrErrors";

/**
 * Engine failures a model call raises. A job's error is the code, the engine in brackets when known, then the engine's
 * own text after a colon (see the job runner): "not-logged-in [codex]: 401 Unauthorized".
 */
const ENGINE_CODES = new Set([
  "not-installed",
  "not-logged-in",
  "unsupported",
  "invalid-selection",
  "cli-failed",
  "refused",
  "quota",
  "model-not-included",
  "stream-truncated",
]);

const ENGINE_ERROR = /^([a-z-]+)(?: \[([\w-]+)\])?(?::|$)/;

/** The message key for the raw error code a background job stopped with. */
export function jobErrorKey(error: string): string {
  if (error === "demo-step-failed") return "jobs.demoFailed";
  if (error.includes("engine-missing")) return "engines.errors.engine-missing";
  const code = ENGINE_ERROR.exec(error)?.[1];
  if (code && ENGINE_CODES.has(code)) return `engines.errors.${code}`;
  return ocrErrorKey(error) ?? sourceErrorKey(error) ?? "jobs.failedGeneral";
}

/**
 * A job failure that reached the screen as a request error: a request that waits for its job (an open answer's check)
 * rethrows the job's error, which arrives as the request's `detail`.
 */
export function requestJobError(err: unknown): {
  key: string;
  engine: string | undefined;
} {
  const detail =
    err && typeof err === "object" && "detail" in err && typeof err.detail === "string"
      ? err.detail
      : "";
  return { key: jobErrorKey(detail), engine: jobErrorEngine(detail) };
}

/** The engine a job's engine failure came from, when the runner recorded it. */
export function jobErrorEngine(error: string): string | undefined {
  const match = ENGINE_ERROR.exec(error);
  return match && ENGINE_CODES.has(match[1]!) ? match[2] : undefined;
}
