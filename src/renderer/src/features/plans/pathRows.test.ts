import { describe, expect, it } from "vitest";
import { topicRows } from "./pathRows";

const topics = [
  { id: "a", title: "Limits" },
  { id: "b", title: "Series" },
];
const step = (activity: string, topicId: string, at: number, result: [number, number] | null = null) => ({
  activity,
  topicId,
  at,
  result: result ? { correct: result[0], total: result[1] } : null,
});

describe("topicRows", () => {
  it("marks steps done, a quiz below the goal as missed, and the path's next step as now", () => {
    const [a, b] = topicRows({
      topics,
      steps: [step("lesson", "a", 1), step("quiz", "a", 2, [1, 4]), step("practice", "a", 3)],
      status: [
        { topicId: "a", mastery: 0.5, dueCards: 0, gaps: 1 },
        { topicId: "b", mastery: 0, dueCards: 0, gaps: 0 },
      ],
      next: { activity: "gaps", topicId: "a" },
      goal: 0.75,
      schedule: [
        { topicId: "a", date: "2026-11-03" },
        { topicId: "b", date: null },
      ],
    });
    expect(a!.steps).toEqual([
      { activity: "lesson", state: "done" },
      { activity: "practice", state: "done" },
      { activity: "quiz", state: "missed", result: { correct: 1, total: 4 } },
      { activity: "gaps", state: "now", count: 1 },
    ]);
    expect(a).toMatchObject({ index: 1, current: true, atGoal: false, done: 3, date: "2026-11-03" });
    expect(a!.last).toEqual({ activity: "practice", at: 3 });
    expect(b).toMatchObject({ index: 2, current: false, done: 0, last: null, date: null });
    expect(b!.steps.map((chip) => chip.state)).toEqual(["todo", "todo", "todo"]);
  });

  it("counts a quiz at the goal as done, shows due flashcards, and gives no date without a schedule", () => {
    const [a] = topicRows({
      topics,
      steps: [step("quiz", "a", 1, [2, 4]), step("quiz", "a", 2, [4, 4])],
      status: [{ topicId: "a", mastery: 0.8, dueCards: 3, gaps: 0 }],
      next: { activity: "cards", topicId: "b" },
      goal: 0.75,
      schedule: null,
    });
    expect(a!.steps).toEqual([
      { activity: "lesson", state: "todo" },
      { activity: "practice", state: "todo" },
      { activity: "quiz", state: "done", result: { correct: 4, total: 4 } },
      { activity: "cards", state: "todo", count: 3 },
    ]);
    expect(a).toMatchObject({ atGoal: true, current: false, date: undefined });
  });
});
