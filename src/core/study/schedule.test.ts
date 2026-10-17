import { describe, expect, it } from "vitest";
import {
  examMaxInterval,
  isMastered,
  newCard,
  retrievability,
  review,
  type ScheduleState,
} from "./schedule";

const MS_PER_DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 15, 10, 0, 0);

describe("review", () => {
  it("new card + good uses the 10 minute learning step", () => {
    const next = review(newCard(T0), "good", T0);
    expect(next.intervalDays).toBe(0);
    expect(next.dueAt - T0).toBe(10 * 60 * 1000);
    expect(next.fsrs?.state).toBe(1);
  });

  it("second good grows the interval to two days", () => {
    const once = review(newCard(T0), "good", T0);
    const twice = review(once, "good", T0 + 10 * 60 * 1000);
    expect(twice.intervalDays).toBeGreaterThan(once.intervalDays);
    expect(twice.intervalDays).toBe(2);
  });

  it("again after growth resets to a short interval due soon", () => {
    const once = review(newCard(T0), "good", T0);
    const twice = review(once, "good", T0);
    const lapse = review(twice, "again", T0);
    expect(lapse.intervalDays).toBeLessThanOrEqual(1);
    expect(lapse.dueAt - T0).toBeLessThanOrEqual(MS_PER_DAY);
  });

  it("gives each of the four ratings its own schedule", () => {
    const warmed = review(review(newCard(T0), "good", T0), "good", T0);
    const at = T0 + 3 * MS_PER_DAY;
    const due = (["again", "hard", "good", "easy"] as const).map(
      (rating) => review(warmed, rating, at).dueAt,
    );
    expect(new Set(due).size).toBe(4);
    expect(due).toEqual([...due].sort((a, b) => a - b));
    expect(review(warmed, "easy", at).fsrs?.stability).toBeGreaterThan(
      review(warmed, "good", at).fsrs!.stability,
    );
  });

  it("counts a Review card as mastered by stability, not interval", () => {
    const base = review(review(newCard(T0), "good", T0), "good", T0);
    const stored = base.fsrs!;
    const make = (state: number, stability: number): ScheduleState => ({
      ...base,
      fsrs: { ...stored, state, stability },
    });
    expect(isMastered(make(2, 21))).toBe(true);
    expect(isMastered(make(2, 20.9))).toBe(false);
    // A relearning card keeps its stability but is not mastered.
    expect(isMastered(make(3, 40))).toBe(false);
    // Long interval but low stability stays in learning.
    expect(isMastered({ ...make(2, 5), intervalDays: 30 })).toBe(false);
    expect(isMastered({ intervalDays: 21, ease: 2.5, dueAt: T0 })).toBe(true);
  });
});

describe("retrievability", () => {
  it("decays within the first day instead of staying at 1", () => {
    const card = review(newCard(T0), "good", T0);
    expect(retrievability(card, T0)).toBe(1);
    const halfDay = retrievability(card, T0 + MS_PER_DAY / 2);
    const fullDay = retrievability(card, T0 + MS_PER_DAY);
    expect(halfDay).toBeLessThan(1);
    expect(fullDay).toBeLessThan(halfDay);
  });

  it("scores a card rated Again at 0 until its next rating", () => {
    const failed = review(newCard(T0), "again", T0);
    expect(failed.fsrs?.state).toBe(1);
    expect(retrievability(failed, T0, "again")).toBe(0);
    expect(retrievability(failed, T0 + MS_PER_DAY, "again")).toBe(0);
    const warmed = review(review(newCard(T0), "good", T0), "good", T0);
    const lapsed = review(warmed, "again", T0 + 3 * MS_PER_DAY);
    expect(lapsed.fsrs?.state).toBe(3);
    expect(retrievability(lapsed, T0 + 3 * MS_PER_DAY, "again")).toBe(0);
    const relearned = review(lapsed, "good", T0 + 3 * MS_PER_DAY + 600_000);
    expect(
      retrievability(relearned, T0 + 3 * MS_PER_DAY + 600_000, "good"),
    ).toBeGreaterThan(0.9);
  });
});

describe("exam date", () => {
  const warmed = () =>
    review(review(newCard(T0), "good", T0), "good", T0 + 10 * 60 * 1000);

  it("keeps every next review on or before the exam day", () => {
    const at = T0 + 2 * MS_PER_DAY;
    const exam = at + 4 * MS_PER_DAY;
    const free = review(warmed(), "easy", at);
    expect(free.intervalDays).toBeGreaterThan(4);
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const next = review(warmed(), rating, at, exam);
      expect(next.intervalDays).toBeLessThanOrEqual(4);
      expect(next.dueAt).toBeLessThanOrEqual(exam + MS_PER_DAY);
    }
    expect(review(warmed(), "easy", at, exam).intervalDays).toBe(4);
  });

  it("keeps the default without a date or after the exam", () => {
    const at = T0 + 2 * MS_PER_DAY;
    const free = review(warmed(), "easy", at);
    expect(review(warmed(), "easy", at, null)).toEqual(free);
    expect(review(warmed(), "easy", at, at - 3 * MS_PER_DAY)).toEqual(free);
  });

  it("counts whole local days to the exam, at least one", () => {
    const morning = new Date(2026, 5, 10, 8, 0).getTime();
    expect(examMaxInterval(null, morning)).toBeNull();
    expect(examMaxInterval(new Date(2026, 5, 9, 9, 0).getTime(), morning)).toBeNull();
    expect(examMaxInterval(new Date(2026, 5, 10, 20, 0).getTime(), morning)).toBe(1);
    expect(examMaxInterval(new Date(2026, 5, 13, 0, 0).getTime(), morning)).toBe(3);
  });
});
