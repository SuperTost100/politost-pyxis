import { errorFields, type ErrorFields } from "../../../shared/error-fields";

type Report = (fields: ErrorFields) => void;

// Typed without the DOM library: unit tests compile this file under the Node configuration.
type WithBridge = { pyxis?: { reportError?: Report } };

function bridgeReport(fields: ErrorFields): void {
  (globalThis as WithBridge).pyxis?.reportError?.(fields);
}

// Chromium raises these when a resize observer's work spills into the next frame; they are not failures.
const NOISE = /^ResizeObserver loop/;

/**
 * Hands a window error to main. Main drops it at once while the crash-report switch is off; otherwise it scrubs it
 * before storing or sending (src/main/crash-reports.ts).
 */
export function reportError(error: unknown, report: Report = bridgeReport): void {
  try {
    const fields = errorFields(error);
    if (NOISE.test(fields.message)) return;
    report(fields);
  } catch {
    /* Reporting must never become the next error. */
  }
}

/** Reports uncaught errors and unhandled rejections of the window. The React route fallback reports its own. */
export function watchWindowErrors(
  target: EventTarget = globalThis as unknown as EventTarget,
  report: Report = bridgeReport,
): void {
  target.addEventListener("error", (event) => {
    const { error, message } = event as Event & { error?: unknown; message?: unknown };
    // A script error without an Error object (a cross-origin script) carries only its message.
    reportError(error ?? { name: "Error", message: String(message ?? ""), stack: "" }, report);
  });
  target.addEventListener("unhandledrejection", (event) => {
    reportError((event as Event & { reason?: unknown }).reason, report);
  });
}
