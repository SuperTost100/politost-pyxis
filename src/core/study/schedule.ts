/**
 * FSRS scheduler (`ts-fsrs`, default parameters, retention 0.9, fuzz off).
 *
 * Button map (the labels are Impossible, Hard, Easy, Very easy):
 * again -> Again, hard -> Hard, good -> Good, easy -> Easy.
 *
 * `intervalDays` is FSRS `scheduled_days`. `ease` keeps the last difficulty
 * so older rows still parse. The full card lives on `fsrs`.
 */

import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  Rating as FsrsRating,
  State as FsrsState,
  type Card,
} from "ts-fsrs";

/** A card counts as mastered once its FSRS stability reaches this many days. */
export const masteredAfterDays = 21;

export type RatingName = "again" | "hard" | "good" | "easy";
export type Rating = RatingName;

export type StoredCard = {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review?: string;
};

export type ScheduleState = {
  intervalDays: number;
  ease: number;
  dueAt: number;
  fsrs?: StoredCard;
};

const scheduler = fsrs(
  generatorParameters({ enable_fuzz: false, request_retention: 0.9 }),
);

function revive(stored: StoredCard): Card {
  return {
    ...stored,
    due: new Date(stored.due),
    last_review: stored.last_review ? new Date(stored.last_review) : undefined,
    state: stored.state,
  };
}

function store(card: Card): StoredCard {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.toISOString(),
  };
}

/** Brand-new card: due immediately, no prior interval. */
export function newCard(now: number): ScheduleState {
  return { intervalDays: 0, ease: 2.5, dueAt: now };
}

export function review(
  state: ScheduleState,
  rating: RatingName,
  now: number,
): ScheduleState {
  const current = state.fsrs
    ? revive(state.fsrs)
    : createEmptyCard(new Date(now));
  const preview = scheduler.repeat(current, new Date(now));
  const next =
    rating === "again"
      ? preview[FsrsRating.Again].card
      : rating === "hard"
        ? preview[FsrsRating.Hard].card
        : rating === "good"
          ? preview[FsrsRating.Good].card
          : preview[FsrsRating.Easy].card;
  const saved = store(next);
  return {
    intervalDays: Math.max(0, saved.scheduled_days),
    ease: saved.difficulty,
    dueAt: new Date(saved.due).getTime(),
    fsrs: saved,
  };
}

/**
 * Queue bucket from FSRS state: `Review` cards with stability of
 * `masteredAfterDays` or more are mastered, everything else reviewed is
 * learning. Rows saved before FSRS have no card state, so they fall back to
 * their interval.
 */
export function isMastered(state: ScheduleState): boolean {
  if (!state.fsrs) return state.intervalDays >= masteredAfterDays;
  return (
    state.fsrs.state === FsrsState.Review &&
    state.fsrs.stability >= masteredAfterDays
  );
}

/** Current recall probability, rather than a rating counted as another success. */
export function retrievability(state: ScheduleState, now: number): number {
  if (!state.fsrs?.last_review || state.fsrs.reps === 0) return 0;
  const value = scheduler.get_retrievability(
    revive(state.fsrs),
    new Date(now),
    false,
  );
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
