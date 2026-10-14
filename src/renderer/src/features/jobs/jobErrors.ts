import { sourceErrorKey } from "../../../../shared/source-errors";
import { ocrErrorKey } from "../../components/ocrErrors";

/** Engine failures a model call raises. A job's error is the code, then the engine's own text after a colon (see `engineIpcError`). */
const ENGINE_CODES = new Set([
  "not-installed",
  "not-logged-in",
  "unsupported",
  "invalid-selection",
  "cli-failed",
  "refused",
  "quota",
]);

/** The message key for the raw error code a background job stopped with. */
export function jobErrorKey(error: string): string {
  if (error === "demo-step-failed") return "jobs.demoFailed";
  if (error.includes("engine-missing")) return "engines.errors.engine-missing";
  const code = error.split(":", 1)[0]!;
  if (ENGINE_CODES.has(code)) return `engines.errors.${code}`;
  return ocrErrorKey(error) ?? sourceErrorKey(error) ?? "jobs.failedGeneral";
}
