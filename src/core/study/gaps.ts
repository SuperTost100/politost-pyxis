import { startOfDay } from "../../shared/local-day";

export type AttemptScore = {
  topicId: string;
  at: number;
  scores: number[];
  openScores?: number[];
};

export type OpenGap = { topicId: string; openedAt: number };


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
  let days = 0;
  for (const step of goodDays(gap, later)) days = step.days;
  return days >= 2;
}

/**
 * When the closing rule of `shouldClose` first held: the time of the attempt after which the answers so far close the
 * gap, or null. One pass over the attempts, where asking `shouldClose` of every prefix would read them again each time.
 */
export function firstClose(gap: OpenGap, later: AttemptScore[]): number | null {
  for (const step of goodDays(gap, later)) if (step.days >= 2) return step.at;
  return null;
}

/** The gap's later attempts in time order, each with the number of days of correct answers since the last miss. */
function* goodDays(gap: OpenGap, later: AttemptScore[]): Generator<{ at: number; days: number }> {
  const after = later
    .filter((attempt) => attempt.topicId === gap.topicId && attempt.at > gap.openedAt)
    .sort((a, b) => a.at - b.at);
  let days = new Set<number>();
  for (const attempt of after) {
    if (attempt.scores.some((score) => score < 1)) days = new Set();
    else if (attempt.scores.length > 0) days.add(startOfDay(attempt.at));
    yield { at: attempt.at, days: days.size };
  }
}
