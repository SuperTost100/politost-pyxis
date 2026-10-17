import { describe, expect, it } from "vitest";
import {
  idleTopics,
  MASTERY_WEIGHTS,
  MASTERY_GROUPS,
  masteryDetail,
  masteryFor,
  SELF_RATING_WINDOW_MS,
  type MasteryEvent,
} from "./mastery";

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

describe("self-rating evidence", () => {
  const rated = (score: number, at: number, exerciseId = "e1"): MasteryEvent => ({
    topicId: "a",
    kind: "self",
    exerciseId,
    score,
    at,
  });

  it("weighs half a quiz answer, like a quick check", () => {
    expect(MASTERY_WEIGHTS.self).toBe(0.5);
    expect(MASTERY_WEIGHTS.self).toBeLessThan(MASTERY_WEIGHTS.quiz);
    expect(masteryFor([rated(1, T0)], T0).a).toBeCloseTo(0.5 / 3.5);
    expect(masteryFor([{ topicId: "a", kind: "quiz", score: 1, at: T0 }], T0).a).toBeCloseTo(1 / 4);
    expect(masteryFor([rated(0, T0)], T0).a).toBe(0);
  });

  it("decays with the 14-day half-life", () => {
    const at = T0 - 14 * MS_PER_DAY;
    expect(masteryFor([rated(1, at)], T0).a).toBeCloseTo(0.25 / 3.25);
  });

  it("counts only the newest rating of one exercise within the window", () => {
    const events = [rated(0, T0 - 3_000), rated(1, T0 - 2_000), rated(0, T0 - 1_000)];
    expect(masteryFor(events, T0).a).toBe(0);
    expect(masteryFor([...events, rated(1, T0)], T0).a).toBeCloseTo(0.5 / 3.5);
  });

  it("keeps a rating made at least a window earlier, as new evidence", () => {
    const events = [rated(1, T0 - SELF_RATING_WINDOW_MS), rated(1, T0)];
    expect(masteryFor(events, T0).a).toBeCloseTo((0.5 * 0.5 ** (SELF_RATING_WINDOW_MS / (14 * MS_PER_DAY)) + 0.5) /
      (3 + 0.5 * 0.5 ** (SELF_RATING_WINDOW_MS / (14 * MS_PER_DAY)) + 0.5));
    const sooner = [rated(1, T0 - SELF_RATING_WINDOW_MS + 1), rated(1, T0)];
    expect(masteryFor(sooner, T0).a).toBeCloseTo(0.5 / 3.5);
  });

  it("does not let a rating on one exercise replace another's", () => {
    const events = [rated(1, T0 - 2, "e1"), rated(1, T0 - 1, "e2")];
    expect(masteryFor(events, T0).a).toBeCloseTo(1 / 4);
  });

  it("replays history: a later change does not reach back before it was made", () => {
    const first = rated(1, T0 - 3_000);
    const changed = rated(0, T0 - 1_000);
    expect(masteryFor([first, changed], T0 - 2_000).a).toBeCloseTo(0.5 / 3.5);
    expect(masteryFor([first, changed], T0).a).toBe(0);
  });
});

describe("masteryDetail", () => {
  const events: MasteryEvent[] = [
    { topicId: "a", kind: "quiz", score: 1, at: T0 - 14 * MS_PER_DAY },
    { topicId: "a", kind: "quiz", answerKind: "open", score: 0.5, at: T0 },
    { topicId: "a", kind: "quiz", score: 0, at: T0 },
    { topicId: "a", kind: "simulation", score: 1, at: T0 },
    { topicId: "a", kind: "check", score: 1, at: T0 - 7 * MS_PER_DAY },
    { topicId: "a", kind: "self", exerciseId: "e", score: 0, at: T0 },
    { topicId: "a", kind: "card", cardId: "c1", score: 0.9, at: T0 },
    { topicId: "a", kind: "card", cardId: "c2", score: 0.7, at: T0 },
    { topicId: "a", kind: "lesson", score: 1, at: T0 },
    { topicId: "b", kind: "quiz", score: 1, at: T0 + 1 },
  ];

  it("counts each kind of evidence with its average", () => {
    const { parts } = masteryDetail(events, T0).a!;
    expect(parts.quiz.count).toBe(3);
    expect(parts.quiz.mean).toBeCloseTo(0.5);
    expect(parts.simulation.count).toBe(1);
    expect(parts.check.count).toBe(1);
    expect(parts.self.count).toBe(1);
    expect(parts.card.count).toBe(2);
    expect(parts.card.mean).toBeCloseTo(0.8);
  });

  it("adds up to the number masteryFor gives, and leaves out what masteryFor leaves out", () => {
    const detail = masteryDetail(events, T0);
    expect(Object.keys(detail)).toEqual(["a"]);
    expect(Object.keys(masteryFor(events, T0))).toEqual(["a"]);
    const { parts, priorWeight, mastery } = detail.a!;
    const sum = (key: "points" | "weight") =>
      MASTERY_GROUPS.reduce((total, group) => total + parts[group][key], 0);
    expect(sum("points") / (priorWeight + sum("weight"))).toBeCloseTo(mastery, 12);
    expect(mastery).toBe(masteryFor(events, T0).a);
  });

  it("reports what age took off", () => {
    const old: MasteryEvent[] = [
      { topicId: "a", kind: "quiz", score: 1, at: T0 - 14 * MS_PER_DAY },
    ];
    const detail = masteryDetail(old, T0).a!;
    // Weight 0.5 now, 1 without decay: 0.5 / 3.5 against 1 / 4.
    expect(detail.mastery).toBeCloseTo(0.5 / 3.5);
    expect(detail.decay).toBeCloseTo(0.5 / 3.5 - 1 / 4);
    expect(masteryDetail([{ ...old[0]!, at: T0 }], T0).a!.decay).toBe(0);
  });
});
