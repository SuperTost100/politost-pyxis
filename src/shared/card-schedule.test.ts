import { describe, expect, it } from "vitest";
import { cardScheduleSchema } from "./card-schedule";
import { newCard, review } from "../core/study/schedule";

describe("portable card schedule validation", () => {
  it("accepts real FSRS review states and valid legacy states", () => {
    const now = Date.parse("2026-10-03T10:00:00.000Z");
    const empty = newCard(now);
    expect(cardScheduleSchema.safeParse(empty).success).toBe(true);
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const next = review(empty, rating, now);
      expect(cardScheduleSchema.safeParse(next).success).toBe(true);
      expect(() =>
        review(cardScheduleSchema.parse(next), "good", next.dueAt),
      ).not.toThrow();
    }
  });
  it("rejects invalid dates, inconsistent fields and unsafe counts", () => {
    const now = Date.parse("2026-10-03T10:00:00.000Z");
    const state = review(newCard(now), "good", now);
    for (const fsrs of [
      { ...state.fsrs!, due: "not-a-date" },
      { ...state.fsrs!, last_review: "not-a-date" },
      { ...state.fsrs!, due: "2026-02-31T10:00:00.000Z" },
      { ...state.fsrs!, state: 4 },
      { ...state.fsrs!, difficulty: Infinity },
      { ...state.fsrs!, reps: -1 },
      { ...state.fsrs!, lapses: state.fsrs!.reps + 1 },
      { ...state.fsrs!, scheduled_days: state.intervalDays + 1 },
    ])
      expect(cardScheduleSchema.safeParse({ ...state, fsrs }).success).toBe(
        false,
      );
  });
});
