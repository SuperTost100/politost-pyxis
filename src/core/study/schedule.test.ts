import { describe, expect, it } from "vitest";
import { newCard, review } from "./schedule";

const MS_PER_DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 15, 10, 0, 0);

describe("review", () => {
  it("new card + good => due about one day later", () => {
    const next = review(newCard(T0), "good", T0);
    expect(next.intervalDays).toBe(1);
    expect(next.dueAt).toBe(T0 + MS_PER_DAY);
  });

  it("second good grows the interval", () => {
    const once = review(newCard(T0), "good", T0);
    const twice = review(once, "good", T0);
    expect(twice.intervalDays).toBeGreaterThan(once.intervalDays);
    expect(twice.intervalDays).toBe(3);
  });

  it("again after growth resets to a short interval due soon", () => {
    const once = review(newCard(T0), "good", T0);
    const twice = review(once, "good", T0);
    const lapse = review(twice, "again", T0);
    expect(lapse.intervalDays).toBeLessThanOrEqual(1);
    expect(lapse.dueAt - T0).toBeLessThanOrEqual(MS_PER_DAY);
  });

  it("easy schedules farther out than good from the same state", () => {
    const warmed = review(review(newCard(T0), "good", T0), "good", T0);
    const goodNext = review(warmed, "good", T0);
    const easyNext = review(warmed, "easy", T0);
    expect(easyNext.intervalDays).toBeGreaterThan(goodNext.intervalDays);
  });
});
