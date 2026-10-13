import { sourceErrorKey } from "../../../../shared/source-errors";
import { ocrErrorKey } from "../../components/ocrErrors";

/** The message key for the raw error code a background job stopped with. */
export function jobErrorKey(error: string): string {
  if (error === "demo-step-failed") return "jobs.demoFailed";
  if (error.includes("engine-missing")) return "engines.errors.engine-missing";
  return ocrErrorKey(error) ?? sourceErrorKey(error) ?? "jobs.failedGeneral";
}
