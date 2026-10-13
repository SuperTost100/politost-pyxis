import { describe, expect, it } from "vitest";
import { newCard, review } from "../../../../core/study/schedule";
import { LEARN_AHEAD_MS, nextLearningDue, trackLearning } from "./learningCards";

const now = Date.UTC(2026, 9, 12, 10);

describe("cards still in learning", () => {
  it("keeps a card rated Again in the session until it is due again", () => {
    const again = review(newCard(now), "again", now);
    expect(again.dueAt - now).toBeLessThanOrEqual(LEARN_AHEAD_MS);
    let pending = trackLearning({}, "a", again.dueAt, now);
    expect(nextLearningDue(pending)).toBe(again.dueAt);
    // A card that graduates to days leaves the wait list.
    pending = trackLearning(pending, "a", now + 86_400_000, now);
    expect(nextLearningDue(pending)).toBeNull();
  });

  it("waits for the earliest of several learning cards", () => {
    let pending = trackLearning({}, "a", now + 10 * 60_000, now);
    pending = trackLearning(pending, "b", now + 60_000, now);
    expect(nextLearningDue(pending)).toBe(now + 60_000);
  });
});
