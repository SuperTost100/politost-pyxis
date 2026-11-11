/** Where one answer stands: graded (four ways), or still waiting for its grade. */
export type ResultMark =
  | "correct"
  | "partial"
  | "wrong"
  | "flagged"
  | "grading"
  | "queued"
  | "ungraded";

/**
 * How many answers are right, half right and wrong, in the order the summary says them. Answers left out of the score
 * are said by the line on the points, and answers still waiting for their grade are not counted yet.
 */
export function tally(marks: ResultMark[]): Array<{ key: "right" | "partial" | "wrong"; count: number }> {
  const count = (mark: ResultMark) => marks.filter((value) => value === mark).length;
  return [
    { key: "right" as const, count: count("correct") },
    { key: "partial" as const, count: count("partial") },
    { key: "wrong" as const, count: count("wrong") },
  ].filter((part) => part.count > 0);
}

type Gap = { topicId: string; severity: "severe" | "minor" | null; misconception: string | null; open: boolean };

/**
 * The gap a Ripasso mirato should drill after this attempt, among the open ones its wrong answers count for: a severe
 * one first, then one the model explained. Without one there is no new step on the path.
 */
export function drillGap<G extends Gap>(gaps: G[]): G | undefined {
  const open = gaps.filter((gap) => gap.open);
  return (
    open.find((gap) => gap.severity === "severe" && gap.misconception) ??
    open.find((gap) => gap.severity === "severe") ??
    open.find((gap) => gap.misconception) ??
    open[0]
  );
}
