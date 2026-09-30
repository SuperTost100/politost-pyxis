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

    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThan(1);
    expect(m).toBeGreaterThan(0.5);
    expect(1 - m).toBeLessThan(m);
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
