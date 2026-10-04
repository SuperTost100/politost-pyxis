import { describe, expect, it } from "vitest";
import { idleTopics, masteryFor, type MasteryEvent } from "./mastery";

const MS_PER_DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 15, 10, 0, 0);

describe("masteryFor", () => {
  it("recent perfect quiz outweighs an old zero quiz", () => {
    const events: MasteryEvent[] = [
      { topicId: "t1", kind: "quiz", score: 0, at: T0 - 30 * MS_PER_DAY },
      { topicId: "t1", kind: "quiz", score: 1, at: T0 },
    ];
    const m = masteryFor(events, T0).t1 ?? 0;

    const old = 0.5 ** (30 / 14);
    expect(m).toBeCloseTo(1 / (3 + 1 + old), 5);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(0.5);
  });
});

describe("idleTopics", () => {
  it("flags a topic silent for 8 days but not one reviewed today", () => {
    const events: MasteryEvent[] = [
      { topicId: "stale", kind: "card", score: 0.8, at: T0 - 8 * MS_PER_DAY },
      { topicId: "fresh", kind: "quiz", score: 1, at: T0 },
    ];

    expect(idleTopics(events, T0, 7)).toEqual(["stale"]);
  });
});

it("uses specified answer weights, ignores lessons and counts a card only once", () => {
  const events: MasteryEvent[] = [
    { topicId: "a", kind: "quiz", answerKind: "open", score: 1, at: T0 },
    { topicId: "a", kind: "quiz", score: 0, at: T0 },
    { topicId: "a", kind: "simulation", score: 1, at: T0 },
    { topicId: "a", kind: "lesson", score: 1, at: T0 },
    { topicId: "a", kind: "card", cardId: "c", score: 1, at: T0 - 100 },
    { topicId: "a", kind: "card", cardId: "c", score: 0.8, at: T0 },
    { topicId: "a", kind: "quiz", score: 1, at: T0 + 1 },
  ];
  expect(masteryFor(events, T0).a).toBeCloseTo(
    (1.5 + 2 + 0.4) / (3 + 1.5 + 1 + 2 + 0.5),
  );
});
