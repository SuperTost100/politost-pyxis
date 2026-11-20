/** The entries of "Da finire" this needs: `plans.unfinished` rows. */
export type Started = { kind: string; topicId: string | null; state: string; total: number };

/**
 * How many questions the topic's quiz already has, for the end of its lesson: a quiz started and not handed in, written
 * in full. Null when there is none, or its questions are still being written or the job stopped, so the size is not known.
 */
export function startedQuizSize(entries: readonly Started[] | undefined, topicId: string): number | null {
  const entry = entries?.find(
    (row) => row.kind === "quiz" && row.topicId === topicId && (row.state === "open" || row.state === "ready") && row.total > 0,
  );
  return entry ? entry.total : null;
}
