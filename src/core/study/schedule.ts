/**
 * Fixed-interval spaced repetition (Anki-like ladder, not FSRS).
 *
 * Interval table (days until next review, from current `intervalDays`):
 * | Rating | intervalDays === 0 | intervalDays > 0                          |
 * |--------|--------------------|-------------------------------------------|
 * | again  | 0                  | 1 (ease −0.20)                            |
 * | hard   | 1                  | max(1, round(interval × 1.2)), ease −0.15 |
 * | good   | 1                  | max(1, round(interval × ease))            |
 * | easy   | 2                  | max(1, round(interval × ease × 1.3)), ease +0.15 |
 *
 * Default ease: 2.5 (clamped 1.3–3.0).
 */

// ponytail: fixed multipliers only — no FSRS stability/retrievability; swap to `ts-fsrs` for production scheduling.
/** A card counts as mastered once its interval reaches this many days. */
export const masteredAfterDays = 21;

export type Rating = "again" | "hard" | "good" | "easy";

export type ScheduleState = {
  intervalDays: number;
  ease: number;
  dueAt: number;
};

const MS_PER_DAY = 86_400_000;
const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

function addDays(fromMs: number, days: number): number {
  return fromMs + days * MS_PER_DAY;
}

function clampEase(ease: number): number {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, ease));
}

/** Brand-new card: due immediately, no prior interval. */
export function newCard(now: number): ScheduleState {
  return { intervalDays: 0, ease: DEFAULT_EASE, dueAt: now };
}

export function review(state: ScheduleState, rating: Rating, now: number): ScheduleState {
  const ease = state.ease;
  const interval = state.intervalDays;

  if (rating === "again") {
    const nextEase = clampEase(ease - 0.2);
    const nextInterval = interval === 0 ? 0 : 1;
    return {
      intervalDays: nextInterval,
      ease: nextEase,
      dueAt: addDays(now, nextInterval),
    };
  }

  if (rating === "hard") {
    const nextEase = clampEase(ease - 0.15);
    const nextInterval = interval === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    return {
      intervalDays: nextInterval,
      ease: nextEase,
      dueAt: addDays(now, nextInterval),
    };
  }

  if (rating === "good") {
    const nextInterval = interval === 0 ? 1 : Math.max(1, Math.round(interval * ease));
    return {
      intervalDays: nextInterval,
      ease,
      dueAt: addDays(now, nextInterval),
    };
  }

  const nextEase = clampEase(ease + 0.15);
  const boostedEase = nextEase * 1.3;
  const nextInterval =
    interval === 0 ? 2 : Math.max(1, Math.round(interval * boostedEase));
  return {
    intervalDays: nextInterval,
    ease: nextEase,
    dueAt: addDays(now, nextInterval),
  };
}
