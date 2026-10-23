import { describe, expect, it } from "vitest";
import { firstClose, shouldClose, shouldOpen, type OpenGap } from "./gaps";

const DAY = 86_400_000;

describe("gaps", () => {
  it("opens on two wrong answers and merges into an open gap", () => {
    const attempt = { topicId: "t", at: 1, scores: [0, 0, 1] };
    expect(shouldOpen(attempt, false)).toBe(true);
    expect(shouldOpen(attempt, true)).toBe(false);
    expect(shouldOpen({ topicId: "t", at: 1, scores: [1], openScores: [0.2] }, false)).toBe(true);
  });

  it("closes only after two clean days", () => {
    const gap: OpenGap = { topicId: "t", openedAt: 1_000 };
    const later = [
      { topicId: "t", at: gap.openedAt + DAY, scores: [1] },
      { topicId: "t", at: gap.openedAt + 2 * DAY, scores: [1] },
    ];
    expect(shouldClose(gap, later)).toBe(true);
    expect(
      shouldClose(gap, [
        later[0]!,
        { topicId: "t", at: gap.openedAt + 2 * DAY, scores: [0] },
      ]),
    ).toBe(false);
    expect(shouldClose(gap, [later[0]!])).toBe(false);
  });

  it("is reset by a miss, not blocked by it for ever (R8 #1)", () => {
    const gap: OpenGap = { topicId: "t", openedAt: Date.UTC(2026, 2, 2, 12) };
    const at = (days: number) => gap.openedAt + days * DAY;
    const miss = { topicId: "t", at: at(1), scores: [0, 1, 1, 1] };
    const clean = (days: number) => ({ topicId: "t", at: at(days), scores: [1] });
    // Day 1 misses; days 2 and 3 are two clean days after it.
    expect(shouldClose(gap, [miss, clean(2)])).toBe(false);
    expect(shouldClose(gap, [miss, clean(2), clean(3)])).toBe(true);
    // A clean day before the miss does not count towards the two.
    expect(shouldClose(gap, [clean(1), { ...miss, at: at(2) }, clean(3)])).toBe(false);
    expect(shouldClose(gap, [clean(1), { ...miss, at: at(2) }, clean(3), clean(4)])).toBe(true);
    // Two sessions on one calendar day are one day.
    expect(shouldClose(gap, [miss, clean(2), { ...clean(2), at: at(2) + 60_000 }])).toBe(false);
    // Another topic's attempts never count.
    expect(shouldClose(gap, [clean(1), { topicId: "other", at: at(2), scores: [1] }])).toBe(false);
  });

  it("finds the first close in one pass, as asking every prefix would", () => {
    const gap: OpenGap = { topicId: "t", openedAt: Date.UTC(2026, 2, 2, 12) };
    // A fixed pseudo-random run of sessions: hits, misses, empty ones, same-day repeats and an earlier one.
    let seed = 7;
    const next = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
    for (let run = 0; run < 50; run += 1) {
      const attempts = Array.from({ length: 12 }, (_, index) => ({
        topicId: "t",
        at: gap.openedAt + Math.floor(index * 0.6 - 1) * DAY + Math.floor(next() * 1000),
        scores: next() < 0.15 ? [] : next() < 0.3 ? [0, 1] : [1],
      })).sort((a, b) => a.at - b.at);
      const byPrefix = attempts.find((_attempt, index) => shouldClose(gap, attempts.slice(0, index + 1)))?.at ?? null;
      expect(firstClose(gap, attempts)).toBe(byPrefix);
    }
    expect(firstClose(gap, [])).toBeNull();
  });
});
