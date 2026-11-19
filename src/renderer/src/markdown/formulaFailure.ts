import { reportError } from "../lib/errorReports";

const FAILED = new Set<string>();

/**
 * Counts a formula KaTeX could not draw, once per distinct source in a session, with the crash-report channel: the report
 * carries a fixed code, never the formula or the text around it, and goes nowhere while the crash-report switch is off.
 */
export function noteFormulaFailure(source: string): void {
  if (FAILED.has(source)) return;
  FAILED.add(source);
  reportError({ code: "formula-not-drawn" });
}
