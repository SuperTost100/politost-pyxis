import { reportError } from "../lib/errorReports";

/** Formulas KaTeX could not draw in this session, by source. Never sent anywhere. */
const failed = new Set<string>();
/** The most sources remembered, so a session that draws thousands of broken formulas keeps no thousands of strings. */
const REMEMBERED = 1000;

/** At most one report in this long: main charges every report to a limit of 20 a minute shared with all other errors. */
export const REPORT_WINDOW_MS = 10 * 60_000;
let reportedAt = Number.NEGATIVE_INFINITY;
let failures = 0;

/**
 * Counts a formula KaTeX could not draw, once per distinct source in a session, here in the window and nowhere else.
 * The crash-report channel hears about it with a fixed diagnostic that carries no text, at most once per window, and
 * hears nothing while its switch is off. Main drops a repeated report only after counting it against the limit it shares
 * with every other error, so a lesson with many broken formulas must not send one report each.
 */
export function noteFormulaFailure(source: string, now = Date.now(), report: typeof reportError = reportError): void {
  if (failed.has(source)) return;
  if (failed.size >= REMEMBERED) failed.clear();
  failed.add(source);
  failures += 1;
  if (now - reportedAt < REPORT_WINDOW_MS) return;
  reportedAt = now;
  report({ code: "formula-not-drawn" });
}

/** How many distinct formulas could not be drawn since the window opened by the app. */
export const formulaFailureCount = (): number => failures;
