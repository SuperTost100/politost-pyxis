import { describe, expect, it } from "vitest";
import { isMastered, newCard, review, type ScheduleState } from "./schedule";

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
