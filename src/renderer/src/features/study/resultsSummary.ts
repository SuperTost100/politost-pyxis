/** Where one answer stands: graded (four ways), or still waiting for its grade. */
export type ResultMark =
  | "correct"
  | "partial"
  | "wrong"
  | "flagged"
  | "grading"
  | "queued"
  | "ungraded";

/** An answer worth exactly half says "a metà"; the tolerance only absorbs float noise from summed credit. */
function isHalf(value: number | undefined): boolean {
  return value !== undefined && Math.abs(value - 0.5) < 1e-9;
}

/**
 * How many answers are right, half right, partly right and wrong, in the order the summary says them. "Half right" is for
 * an answer worth exactly half; any other partial credit (0,9 of 1, 0,25 of 1) is "partly right", so the words never
 * contradict the points beside them. Answers left out of the score are said by the line on the points, and answers still
 * waiting for their grade are not counted yet.
 */
export function tally(
  answers: Array<{ mark: ResultMark; value?: number }>,
): Array<{ key: "right" | "half" | "partly" | "wrong"; count: number }> {
  const count = (test: (answer: { mark: ResultMark; value?: number }) => boolean) => answers.filter(test).length;
  return [
    { key: "right" as const, count: count((answer) => answer.mark === "correct") },
    { key: "half" as const, count: count((answer) => answer.mark === "partial" && isHalf(answer.value)) },
    { key: "partly" as const, count: count((answer) => answer.mark === "partial" && !isHalf(answer.value)) },
    { key: "wrong" as const, count: count((answer) => answer.mark === "wrong") },
  ].filter((part) => part.count > 0);
}

const STATUS_WORD: Record<ResultMark, string> = {
  correct: "results.right",
  partial: "results.partly",
  wrong: "results.wrong",
  flagged: "quiz.excluded",
  grading: "results.grading",
  queued: "results.queued",
  ungraded: "results.ungraded",
};

/** The locale key of the word an answer's row says: "A metà" at exactly half, "In parte" for other partial credit. */
export function statusWordKey(item: { mark: ResultMark; value?: number; answer: string }): string {
  if (item.mark === "wrong" && !item.answer) return "results.dontKnow";
  if (item.mark === "partial" && isHalf(item.value)) return "results.half";
  return STATUS_WORD[item.mark];
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
