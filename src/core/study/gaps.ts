export type AttemptScore = {
  topicId: string;
  at: number;
  scores: number[];
  openScores?: number[];
};

export type OpenGap = { topicId: string; openedAt: number };

function day(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function shouldOpen(attempt: AttemptScore, alreadyOpen: boolean): boolean {
  if (alreadyOpen) return false;
  const wrong = attempt.scores.filter((score) => score < 1).length;
  const weakOpen = (attempt.openScores ?? []).some((score) => score < 0.3);
  return wrong >= 2 || weakOpen;
}

/**
 * 4.7: a gap closes when answers are correct in two sessions on different (local) days after it opened, with no wrong
 * answer between them. A miss therefore only resets the count: the sessions that count are those after the last one.
 * The caller passes only the answers that count for this gap; a miss linked to another gap is left out.
 */
export function shouldClose(
  gap: OpenGap,
  later: AttemptScore[],
): boolean {
  const after = later
    .filter((attempt) => attempt.topicId === gap.topicId && attempt.at > gap.openedAt)
    .sort((a, b) => a.at - b.at);
  const lastMiss = after.findLastIndex((attempt) => attempt.scores.some((score) => score < 1));
  const goodDays = new Set<number>();
  for (const attempt of after.slice(lastMiss + 1)) {
    if (attempt.scores.length > 0) goodDays.add(day(attempt.at));
  }
  return goodDays.size >= 2;
}
