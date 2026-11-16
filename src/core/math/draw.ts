import { runtimeRequest } from "./runtime-client";
import type { PythonRun } from "./python";

/**
 * Draws a figure in the drawing window, which main runs, and answers in the shape of a Python run so one runner serves
 * every kind: the picture in `images`, or the failure in `stderr`. A failure that starts with `runtime-` is no fault of
 * the figure (no window, no pack, a crash), and one with a message is the figure's own. Main checks what it gets from
 * the window; this only reads the checked answer again, as a PNG data URL or a short text.
 */
export async function drawInWindow(
  kind: string,
  code: string,
  timeoutMs: number,
): Promise<PythonRun> {
  const failed = (stderr: string, timedOut = false): PythonRun => ({
    stdout: "",
    stderr,
    images: [],
    timedOut,
    truncated: false,
  });
  try {
    const reply = (await runtimeRequest("draw", { kind, code, timeoutMs })) as {
      image?: unknown;
      error?: unknown;
      timedOut?: unknown;
    } | null;
    if (typeof reply?.image === "string")
      return { stdout: "", stderr: "", images: [reply.image], timedOut: false, truncated: false };
    return failed(
      typeof reply?.error === "string" ? reply.error.slice(0, 500) : "runtime-draw-failed",
      reply?.timedOut === true,
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : "runtime-unavailable");
  }
}
