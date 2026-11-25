import { Check, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./CheckBadge.css";

/** The checker's reasons for a failed claim that are about a set of solutions; any other is about a value. */
const SOLUTIONS = new Set(["solution-set", "incomplete-solution-set"]);

/**
 * The result of a step's math check, beside the step. A verified step gets a grey check at its right edge, which says
 * what it means on hover or focus. Where a sources row counts the checks, it shows only while that row is open
 * (`[data-checks-shown]` on the host); anywhere else it always shows. A failed step says so under itself, with the reason, always: it is a warning. A claim the checker cannot
 * evaluate tells the student nothing, so it shows nothing.
 */
export function CheckBadge({
  state,
  reason,
  count = 1,
}: {
  state: "verified" | "failed" | "none";
  reason?: string;
  /** For a verified mark: how many checks of the step passed, which its label says. */
  count?: number;
}) {
  const { t } = useTranslation();
  if (state === "none") return null;
  if (state === "verified") {
    const label = t("sourcesRow.checkMark", { count });
    return (
      <span className="px-check-badge is-verified" role="img" aria-label={label} tabIndex={0}>
        <Check size={16} strokeWidth={2} aria-hidden />
        <span className="px-check-tip" aria-hidden>
          {label}
        </span>
      </span>
    );
  }
  return (
    <p className="px-check-badge is-failed">
      <b>
        <TriangleAlert size={15} strokeWidth={2} aria-hidden />
        {t("sourcesRow.failed")}
      </b>
      <span>{t(SOLUTIONS.has(reason ?? "") ? "sourcesRow.failedSolutions" : "sourcesRow.failedValue")}</span>
    </p>
  );
}
