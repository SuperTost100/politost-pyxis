/**
 * FSRS scheduler (`ts-fsrs`, default parameters, retention 0.9, fuzz off).
 *
 * Button map (the labels are Again, Hard, Good, Easy):
 * again -> Again, hard -> Hard, good -> Good, easy -> Easy.
 *
 * `intervalDays` is FSRS `scheduled_days`. `ease` keeps the last difficulty
 * so older rows still parse. The full card lives on `fsrs`.
 *
 * A plan with an exam date caps the interval at the days left until the exam,
 * so the last review lands on the exam day at the latest. ts-fsrs keeps Hard,
 * Good and Easy a day apart even above its `maximum_interval`, so the cap is
 * applied to the chosen card instead.
 */

import {
  createEmptyCard,
  dateDiffInDays,
  fsrs,
  generatorParameters,
  Rating as FsrsRating,
  State as FsrsState,
  type Card,
} from "ts-fsrs";
import { forgettingCurve } from "ts-fsrs/models/fsrs-6";
import { daysBetween } from "../../shared/local-day";

/** A card counts as mastered once its FSRS stability reaches this many days. */
const masteredAfterDays = 21;

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

// ts-fsrs 6 keeps this legacy facade on FSRS-6, the model every stored card was scheduled with. Moving to its
// DefaultScheduler (FSRS-7) would need each card's full history replayed with FSRS-7 weights.
const parameters = generatorParameters({
  enable_fuzz: false,
  request_retention: 0.9,
});
const scheduler = fsrs(parameters);
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/**
 * The longest interval that keeps the next review on or before the exam day: whole local days from today to the exam,
 * at least 1. No date, or an exam already past, gives null and the default maximum.
 */
export function examMaxInterval(
  examAt: number | null | undefined,
  now: number,
): number | null {
  if (examAt == null) return null;
  const days = daysBetween(now, examAt);
  return days < 0 ? null : Math.max(1, days);
}

function revive(stored: StoredCard): Card {
  return {
    ...stored,
    due: new Date(stored.due),
    last_review: stored.last_review ? new Date(stored.last_review) : undefined,
    state: stored.state as FsrsState,
  };
}

/**
 * `elapsed_days` is the whole UTC days from the previous review to this one, 0 for a new card. ts-fsrs 6 no longer
 * keeps it on the card, but stored rows and plan files carry it, so Pyxis works it out as ts-fsrs 5 did.
 */
function store(card: Card, previous: Card, now: number): StoredCard {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days:
      previous.state !== FsrsState.New && previous.last_review
        ? dateDiffInDays(previous.last_review, new Date(now))
        : 0,
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
  /** The plan's exam date; no review is scheduled after its day. */
  examAt?: number | null,
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
  const saved = store(next, current, now);
  // ts-fsrs 6 keeps learning steps to the second, so Hard on the first step, halfway between 1 and 10 minutes, is
  // 5.5 minutes. ts-fsrs 5 rounded a step to whole minutes (6), and Pyxis keeps that schedule.
  if (saved.scheduled_days === 0) {
    const minutes = Math.round((next.due.getTime() - now) / MS_PER_MINUTE);
    saved.due = new Date(now + minutes * MS_PER_MINUTE).toISOString();
  }
  const maxDays = examMaxInterval(examAt, now);
  if (maxDays != null && saved.scheduled_days > maxDays) {
    saved.scheduled_days = maxDays;
    saved.due = new Date(now + maxDays * MS_PER_DAY).toISOString();
  }
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

/**
 * Current recall probability, rather than a rating counted as another success.
 * Elapsed time is fractional: ts-fsrs `get_retrievability` rounds down to whole
 * days, which keeps a card at 1 for the day of its review. A card whose latest
 * rating is Again is in Learning or Relearning and scores 0 until it is rated
 * again, so failing cards cannot raise mastery.
 */
export function retrievability(
  state: ScheduleState,
  now: number,
  latestRating?: string | null,
): number {
  if (!state.fsrs?.last_review || state.fsrs.reps === 0) return 0;
  if (state.fsrs.state === FsrsState.New) return 0;
  if (
    latestRating === "again" &&
    (state.fsrs.state === FsrsState.Learning ||
      state.fsrs.state === FsrsState.Relearning)
  )
    return 0;
  const elapsedDays = Math.max(
    0,
    (now - new Date(state.fsrs.last_review).getTime()) / MS_PER_DAY,
  );
  const value = forgettingCurve(
    parameters.w,
    elapsedDays,
    state.fsrs.stability,
  );
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
