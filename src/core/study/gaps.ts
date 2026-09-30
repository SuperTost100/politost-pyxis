export type AttemptScore = {
  topicId: string;
  at: number;
  scores: number[];
  openScores?: number[];
};

export type OpenGap = { topicId: string; openedAt: number };

const DAY = 86_400_000;

function day(at: number): number {
  return Math.floor(at / DAY);
}

export function shouldOpen(attempt: AttemptScore, alreadyOpen: boolean): boolean {
  if (alreadyOpen) return false;
  const wrong = attempt.scores.filter((score) => score < 1).length;
  const weakOpen = (attempt.openScores ?? []).some((score) => score < 0.3);
  return wrong >= 2 || weakOpen;
}

export function shouldClose(
  gap: OpenGap,
  later: AttemptScore[],
): boolean {
  const after = later
    .filter((attempt) => attempt.topicId === gap.topicId && attempt.at > gap.openedAt)
    .sort((a, b) => a.at - b.at);
  const goodDays = new Set<number>();
  for (const attempt of after) {
    if (attempt.scores.some((score) => score < 1)) return false;
    if (attempt.scores.length > 0 && attempt.scores.every((score) => score >= 1)) {
      goodDays.add(day(attempt.at));
    }
  }
  return goodDays.size >= 2;
}
