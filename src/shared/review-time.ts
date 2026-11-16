/** The most seconds one flashcard review counts as study time, so a card left open does not count its whole wait. */
export const MAX_REVIEW_SECONDS = 60;

/**
 * The time to keep for a review that was on screen for `seconds`: a whole number up to `MAX_REVIEW_SECONDS`, or null
 * when there is none to keep (not given, a clock that went back, not a number). The page and core both use it, and the
 * request accepts any number, because a rating must never be lost to the measurement of its time.
 */
export function reviewSeconds(seconds: number | undefined): number | null {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return null;
  return Math.min(MAX_REVIEW_SECONDS, Math.round(seconds));
}
