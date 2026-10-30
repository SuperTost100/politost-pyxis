import { describe, expect, it } from "vitest";
import { needsWeeklyHours, topicRows } from "./pathRows";

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

  it("drops a leading number that repeats the row's own, since the row draws it", () => {
    const titles = ["1. Misure e vettori", "2. Cinematica del punto", "Limiti", "3. Serie", "2020. Storia"];
    const rows = topicRows({
      topics: titles.map((title, i) => ({ id: `t${i}`, title })),
      steps: [],
      status: [],
      next: null,
      goal: 0.75,
      schedule: null,
    });
    // Row 4 holds "3. Serie": that number is not the row's, so it stays.
    expect(rows.map((row) => row.title)).toEqual([
      "Misure e vettori",
      "Cinematica del punto",
      "Limiti",
      "3. Serie",
      "2020. Storia",
    ]);
  });

  it("measures a full-mark goal against the reachable target, as core does", () => {
    const [a] = topicRows({
      topics,
      steps: [step("quiz", "a", 1, [99, 100])],
      status: [{ topicId: "a", mastery: 0.995, dueCards: 0, gaps: 0 }],
      next: null,
      goal: 1,
      schedule: null,
    });
    expect(a!.atGoal).toBe(true);
    expect(a!.steps[2]).toMatchObject({ activity: "quiz", state: "done" });
  });
});

describe("needsWeeklyHours", () => {
  const now = new Date(2026, 9, 30, 15).getTime();
  const base = {
    schedule: null,
    weeklyHours: null,
    examAt: new Date(2026, 10, 20, 9).getTime(),
    archived: false,
    open: 3,
    now,
  };
  it("asks for hours when an upcoming exam has none and topics are still short of the goal", () => {
    expect(needsWeeklyHours(base)).toBe(true);
  });
  it("stays quiet while loading, once hours or a schedule exist, and when there is nothing to date", () => {
    expect(needsWeeklyHours({ ...base, schedule: undefined })).toBe(false);
    expect(needsWeeklyHours({ ...base, weeklyHours: undefined })).toBe(false);
    expect(needsWeeklyHours({ ...base, weeklyHours: 6 })).toBe(false);
    expect(needsWeeklyHours({ ...base, schedule: { topics: [] } })).toBe(false);
    expect(needsWeeklyHours({ ...base, examAt: null })).toBe(false);
    expect(needsWeeklyHours({ ...base, archived: true })).toBe(false);
    expect(needsWeeklyHours({ ...base, open: 0 })).toBe(false);
  });
  it("stays quiet on the exam day and after it, when the planner has no days to give", () => {
    expect(needsWeeklyHours({ ...base, examAt: new Date(2026, 9, 30, 18).getTime() })).toBe(false);
    expect(needsWeeklyHours({ ...base, examAt: new Date(2026, 9, 29, 9).getTime() })).toBe(false);
    expect(needsWeeklyHours({ ...base, examAt: new Date(2026, 9, 31, 9).getTime() })).toBe(true);
  });
});
