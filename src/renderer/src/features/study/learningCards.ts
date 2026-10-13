/** A card rated into a learning step comes back in the same session when it is due within this window. */
export const LEARN_AHEAD_MS = 20 * 60_000;

/** Cards of this session waiting for their next learning step, by id, with the time they are due. */
export type LearningCards = Record<string, number>;

export function trackLearning(
  pending: LearningCards,
  cardId: string,
  dueAt: number,
  now: number,
): LearningCards {
  const { [cardId]: _previous, ...rest } = pending;
  return dueAt - now <= LEARN_AHEAD_MS ? { ...rest, [cardId]: dueAt } : rest;
}

export function nextLearningDue(pending: LearningCards): number | null {
  const times = Object.values(pending);
  return times.length ? Math.min(...times) : null;
}
