/** The four answers to a flashcard, from the one the student did not know to the easiest. */
export const RATINGS = ["again", "hard", "good", "easy"] as const;
export type RatingName = (typeof RATINGS)[number];

/** One answer given in this session: the card as it was shown, and the review that stored the answer. */
export type SeenCard = {
  cardId: string;
  reviewId: string;
  rating: RatingName;
  front: string;
  subject: string | null;
};

/** Cards listed under each answer before "N more" folds the rest. */
export const SHOWN_PER_ANSWER = 3;

export function rateCounts(seen: SeenCard[]): Record<RatingName, number> {
  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const item of seen) counts[item.rating] += 1;
  return counts;
}

/**
 * The cards seen, listed under the answer the student gave, in the order of the answers and, inside one answer, in the
 * order they were answered. An answer nobody gave has no group. A card waiting to come back is shown on its own, so
 * the answer that sent it there is left out of its group.
 */
export function groupSeen(seen: SeenCard[], waiting: ReadonlySet<string>) {
  const sentWaiting = new Set<string>();
  for (const cardId of waiting) {
    const last = seen.findLast((item) => item.cardId === cardId);
    if (last) sentWaiting.add(last.reviewId);
  }
  return RATINGS.map((rating) => ({
    rating,
    cards: seen.filter((item) => item.rating === rating && !sentWaiting.has(item.reviewId)),
  })).filter((group) => group.cards.length > 0);
}

/** How far a bar goes: the most given answer fills it, the others in proportion, and an answer never given is empty. */
export function barShare(count: number, counts: Record<RatingName, number>): number {
  const most = Math.max(...RATINGS.map((rating) => counts[rating]));
  return most === 0 ? 0 : count / most;
}

/** Time left as `m:ss`, or `h:mm:ss` from an hour on. A moment already past reads 0:00. */
export function countdownText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Whole minutes left, rounded up, for the one sentence a screen reader hears; never under one. */
export function minutesLeft(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** The cards coming back later today, one row per subject with its first time, the soonest subject first. */
export function laterBySubject(later: Array<{ at: number; subject: string | null }>) {
  const rows = new Map<string | null, { subject: string | null; count: number; at: number }>();
  for (const item of later) {
    const row = rows.get(item.subject);
    if (row) {
      row.count += 1;
      row.at = Math.min(row.at, item.at);
    } else rows.set(item.subject, { subject: item.subject, count: 1, at: item.at });
  }
  return [...rows.values()].sort((a, b) => a.at - b.at);
}
