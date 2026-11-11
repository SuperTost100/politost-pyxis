import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { appendEvent } from "../events";
import { rateCard, setNewCardsPerDay } from "../study/cards";
import { recordStep } from "./steps";
import {
  dueEverywhere,
  examRings,
  examlessDue,
  finishDays,
  neededHours,
  planSchedule,
  readPlannerSettings,
  remainingMinutes,
  remainingWork,
  savePlannerHours,
  sessionPlan,
  spread,
  todayPlan,
} from "./planner";

type Db = ReturnType<typeof openDatabase>;

/** Saturday 17 October 2026, 10:00 local time. */
const now = new Date(2026, 9, 17, 10).getTime();
const day = (offset: number, hour = 9) => new Date(2026, 9, 17 + offset, hour).getTime();

function addPlan(
  db: Db,
  id: string,
  options: { examIn?: number | null; topics?: number; updatedAt?: number } = {},
) {
  db.prepare(
    "INSERT INTO plans (id, title, status, target, exam_at, created_at, updated_at) VALUES (?, ?, 'ready', 0.75, ?, 1, ?)",
  ).run(
    id,
    `Plan ${id}`,
    options.examIn == null ? null : day(options.examIn),
    options.updatedAt ?? 1,
  );
  for (let index = 0; index < (options.topics ?? 2); index += 1)
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, ?, ?, 1)",
    ).run(`${id}-t${index}`, id, `Topic ${index} of ${id}`, index);
}

function dueCard(db: Db, id: string, planId: string, topicId: string) {
  db.prepare(
    "INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES (?, ?, ?, 'Front', 'Back', 1)",
  ).run(id, planId, topicId);
}

describe("remaining work", () => {
  it("counts the diagnostic, a lesson and three activities per untouched topic, and one simulation", () => {
    const topics = [
      { id: "a", mastery: 0 },
      { id: "b", mastery: 0 },
    ];
    // 15 diagnostic + 2 * (30 lesson + 3 * 20) + 60 simulation.
    expect(remainingMinutes({ topics, steps: [], hasIntro: false, target: 0.75 })).toBe(255);
    expect(remainingMinutes({ topics, steps: [], hasIntro: true, target: 0.75 })).toBe(265);
  });

  it("drops what is done and scales the activities by how far a topic is from the target", () => {
    const steps = [
      { activity: "diagnostic" as const, topicId: null },
      { activity: "lesson" as const, topicId: "a" },
      { activity: "simulation" as const, topicId: null },
    ];
    // a is read and halfway: ceil(1.5) = 2 activities. b reached the target.
    expect(
      remainingMinutes({
        topics: [
          { id: "a", mastery: 0.375 },
          { id: "b", mastery: 0.8 },
        ],
        steps,
        hasIntro: false,
        target: 0.75,
      }),
    ).toBe(40);
  });

  it("has nothing left when every topic is at the target and a simulation is done", () => {
    expect(
      remainingMinutes({
        topics: [{ id: "a", mastery: 0.9 }],
        steps: [{ activity: "simulation", topicId: null }],
        hasIntro: false,
        target: 0.75,
      }),
    ).toBe(0);
  });
});

describe("spreading the work", () => {
  it("gives each exam its own pace, evenly up to the day before the exam", () => {
    const { days, left } = spread(
      [
        { id: "near", examDay: 2, remaining: 120 },
        { id: "far", examDay: 6, remaining: 120 },
      ],
      () => 120,
    );
    expect(days.map((given) => given.get("near") ?? 0)).toEqual([60, 60, 0, 0, 0, 0]);
    expect(days.map((given) => given.get("far") ?? 0)).toEqual([20, 20, 20, 20, 20, 20]);
    expect(left.get("near")).toBe(0);
    expect(left.get("far")).toBe(0);
  });

  it("gives every exam the same share of its pace when time is short", () => {
    const { days } = spread(
      [
        { id: "near", examDay: 2, remaining: 120 },
        { id: "far", examDay: 6, remaining: 120 },
      ],
      () => 40,
    );
    expect(days[0]!.get("near")).toBeCloseTo(30);
    expect(days[0]!.get("far")).toBeCloseTo(10);
  });

  it("leaves work on the exam day when there is not enough time", () => {
    const { left } = spread([{ id: "a", examDay: 2, remaining: 300 }], () => 60);
    expect(left.get("a")).toBeCloseTo(180);
  });

  it("works out the weekly hours that keep every exam on time", () => {
    // 60 min in 2 days is 30 a day; 60 + 600 in 10 days is 66 a day, so 7.7 h a week, rounded up to 8.
    expect(
      neededHours([
        { id: "a", examDay: 2, remaining: 60 },
        { id: "b", examDay: 10, remaining: 600 },
      ]),
    ).toBe(8);
  });
});

describe("planner settings", () => {
  it("stores the usual hours and one week's own hours, and clears a week with null", () => {
    const db = openDatabase(":memory:");
    expect(readPlannerSettings(db)).toEqual({ weeklyHours: null, weeks: {} });
    savePlannerHours(db, { hours: 10 }, now);
    savePlannerHours(db, { week: "2026-10-19", hours: 4 }, now);
    expect(readPlannerSettings(db)).toEqual({ weeklyHours: 10, weeks: { "2026-10-19": 4 } });
    savePlannerHours(db, { week: "2026-10-19", hours: null }, now);
    expect(readPlannerSettings(db).weeks).toEqual({});
  });

  it("forgets weeks that are over", () => {
    const db = openDatabase(":memory:");
    savePlannerHours(db, { week: "2026-10-05", hours: 4 }, now);
    expect(readPlannerSettings(db).weeks).toEqual({});
  });
});

describe("session plan", () => {
  it("lists dated exams only and spreads nothing until hours are set", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "dated", { examIn: 5 });
    addPlan(db, "undated");
    addPlan(db, "past", { examIn: -2 });
    const plan = sessionPlan(db, now);
    expect(plan.exams.map((exam) => exam.planId)).toEqual(["dated"]);
    expect(plan.exams[0]).toMatchObject({ examDate: "2026-10-22", daysToExam: 5, remainingMinutes: 255 });
    expect(plan.weeks).toEqual([]);
    expect(plan.days).toEqual([]);
    expect(plan.neededHours).toBe(6);
  });

  it("spreads the work over weeks and days and marks the exam days", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 3 });
    addPlan(db, "b", { examIn: 10 });
    savePlannerHours(db, { hours: 14 }, now);
    const plan = sessionPlan(db, now);
    // Saturday 17 October: this week has two days left, then the week of the 19th and the week of the 26th.
    expect(plan.weeks.map((week) => week.start)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(plan.days[0]!.date).toBe("2026-10-17");
    expect(plan.days[3]!.exams).toEqual(["a"]);
    expect(plan.weeks[1]!.exams).toEqual(["a"]);
    expect(plan.weeks[2]!.exams).toEqual(["b"]);
    // Two hours a day cover both paces: 255 / 3 and 255 / 10 minutes.
    expect(plan.days[0]!.plans).toEqual([
      { planId: "a", minutes: 85 },
      { planId: "b", minutes: 25 },
    ]);
    expect(plan.exams.every((exam) => exam.behind === null)).toBe(true);
  });

  it("warns when an exam falls behind, with the days late and the mastery at the exam", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 2 });
    savePlannerHours(db, { hours: 7 }, now);
    const [exam] = sessionPlan(db, now).exams;
    // 255 minutes of work, 60 a day for two days: 135 left, 3 more days at that pace.
    expect(exam!.behind).toEqual({ daysLate: 3, masteryAtExam: expect.closeTo(0.75 * (120 / 255), 5) });
    expect(todayPlan(db, now).behind.map((item) => item.planId)).toEqual(["a"]);
  });

  it("uses one week's own hours for that week", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 12 });
    savePlannerHours(db, { hours: 7 }, now);
    savePlannerHours(db, { week: "2026-10-19", hours: 0 }, now);
    const plan = sessionPlan(db, now);
    expect(plan.weeks[1]).toMatchObject({ start: "2026-10-19", hours: 0, custom: true, plans: [] });
    expect(plan.weeks[2]).toMatchObject({ hours: 7, custom: false });
  });

  it("re-plans from what is left when days are missed", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 6 });
    savePlannerHours(db, { hours: 14 }, now);
    // 255 minutes over 6 days.
    const first = sessionPlan(db, now).days[0]!.plans[0]!.minutes;
    expect(first).toBe(45);
    // Three days later nothing was done: the same work has fewer days, so each day gets more.
    const later = sessionPlan(db, day(3, 10)).days[0]!.plans[0]!.minutes;
    expect(later).toBeGreaterThan(first);
  });
});

describe("expected dates", () => {
  it("splits the remaining work into the start, each topic in order and the simulation", () => {
    const pieces = remainingWork({
      topics: [
        { id: "a", mastery: 0 },
        { id: "b", mastery: 0.8 },
        { id: "c", mastery: 0 },
      ],
      steps: [],
      hasIntro: true,
      target: 0.75,
    });
    // b is at the target, so it has no piece, and the student has studied, so there is no start either.
    expect(pieces).toEqual([
      { kind: "topic", topicId: "a", minutes: 90 },
      { kind: "topic", topicId: "c", minutes: 90 },
      { kind: "simulation", topicId: null, minutes: 60 },
    ]);
    expect(
      remainingWork({ topics: [{ id: "a", mastery: 0 }], steps: [], hasIntro: true, target: 0.75 })[0],
    ).toEqual({ kind: "start", topicId: null, minutes: 25 });
  });

  it("ends each piece on the day the minutes so far cover it, after the work done today", () => {
    expect(finishDays([15, 90, 90, 60], 0, Array(6).fill(42.5))).toEqual([0, 2, 4, 5]);
    // 30 minutes done today come first: 90 minutes of work end on the third day.
    expect(finishDays([60], 30, [40, 40, 40])).toEqual([2]);
    expect(finishDays([10, 100], 0, [50])).toEqual([0, null]);
  });

  it("dates each topic and the simulation at the planner's pace", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 6 });
    savePlannerHours(db, { hours: 14 }, now);
    // 255 minutes, 42.5 a day: the start on day 0, the topics end on days 2 and 4, the simulation on day 5.
    expect(planSchedule(db, "a", now)).toEqual({
      topics: [
        { topicId: "a-t0", date: "2026-10-19" },
        { topicId: "a-t1", date: "2026-10-21" },
      ],
      simulation: { date: "2026-10-22" },
      behind: null,
    });
  });

  it("leaves out what does not fit before the exam", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 2 });
    savePlannerHours(db, { hours: 7 }, now);
    const schedule = planSchedule(db, "a", now)!;
    expect(schedule.topics).toEqual([
      { topicId: "a-t0", date: "2026-10-18" },
      { topicId: "a-t1", date: null },
    ]);
    expect(schedule.simulation).toEqual({ date: null });
    expect(schedule.behind).not.toBeNull();
  });

  it("has no dates without hours, without an exam date or for an archived exam", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "dated", { examIn: 6 });
    addPlan(db, "undated");
    expect(planSchedule(db, "dated", now)).toBeNull();
    savePlannerHours(db, { hours: 14 }, now);
    expect(planSchedule(db, "undated", now)).toBeNull();
    db.prepare("UPDATE plans SET archived_at = 1 WHERE id = 'dated'").run();
    expect(planSchedule(db, "dated", now)).toBeNull();
  });
});

describe("Oggi", () => {
  it("puts due cards first as one item, then the closest exam, then plans without a date", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "undated", { updatedAt: 5 });
    addPlan(db, "far", { examIn: 20 });
    addPlan(db, "near", { examIn: 4 });
    addPlan(db, "past", { examIn: -1 });
    dueCard(db, "c1", "far", "far-t0");
    dueCard(db, "c2", "near", "near-t1");
    const today = todayPlan(db, now);
    expect(today.cards).toEqual({ due: 2, plans: 2, ratedToday: 0 });
    expect(today.items.map((item) => item.planId)).toEqual(["near", "far", "undated"]);
    // The path looks past due cards for the plan's own item: a new plan starts with the diagnostic.
    expect(today.items[0]!.next).toMatchObject({ activity: "diagnostic", topicId: null });
    expect(today.items[0]!.complete).toBe(false);
  });

  it("ticks a plan off after one step today when no hours are set", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(-1));
    expect(todayPlan(db, now).items[0]!.complete).toBe(false);
    recordStep(db, "a", { activity: "lesson", topicId: "a-t1" }, day(0, 9));
    const item = todayPlan(db, now).items[0]!;
    expect(item.complete).toBe(true);
    expect(item.done).toEqual([{ activity: "lesson", topicId: "a-t1", topicTitle: "Topic 1 of a" }]);
  });

  it("ticks a plan off once today's steps cover the planner's minutes for it", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    // 255 minutes over 4 days is about 64 a day; 3.5 h a week gives 30.
    savePlannerHours(db, { hours: 3.5 }, now);
    const before = todayPlan(db, now).items[0]!;
    expect(before.minutesToday).toBe(30);
    expect(before.complete).toBe(false);
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 9));
    const after = todayPlan(db, now).items[0]!;
    expect(after.minutesToday).toBe(30);
    expect(after.minutesLeft).toBe(0);
    expect(after.complete).toBe(true);
  });

  it("does not tick off a plan whose minutes today are too small to matter", () => {
    const db = openDatabase(":memory:");
    for (const id of ["a", "b", "c", "d"]) addPlan(db, id, { examIn: 4 });
    // 0.5 h a week split over four exams leaves each a couple of minutes today.
    savePlannerHours(db, { hours: 0.5 }, now);
    // Allocations under 2.5 minutes are left out, so none shows as done with no work.
    expect(todayPlan(db, now).items).toEqual([]);
  });

  it("leaves out an archived exam, its due flashcards and its sessions", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "kept", { examIn: 10 });
    addPlan(db, "done", { examIn: 3 });
    dueCard(db, "c1", "kept", "kept-t0");
    dueCard(db, "c2", "done", "done-t0");
    db.prepare("UPDATE plans SET archived_at = 1 WHERE id = 'done'").run();
    const today = todayPlan(db, now);
    expect(today.items.map((item) => item.planId)).toEqual(["kept"]);
    expect(today.cards).toMatchObject({ due: 1, plans: 1 });
    expect(dueEverywhere(db, now).map((card) => card.planId)).toEqual(["kept"]);
    savePlannerHours(db, { hours: 10 }, now);
    expect(sessionPlan(db, now).exams.map((exam) => exam.planId)).toEqual(["kept"]);
  });

  it("is empty with no plans", () => {
    const db = openDatabase(":memory:");
    expect(todayPlan(db, now)).toEqual({ planned: false, behind: [], cards: null, items: [] });
  });

  it("serves due cards from every plan, the closest exam first", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "far", { examIn: 20 });
    addPlan(db, "near", { examIn: 4 });
    dueCard(db, "c-far", "far", "far-t0");
    dueCard(db, "c-near", "near", "near-t0");
    expect(dueEverywhere(db, now).map((card) => [card.id, card.planId])).toEqual([
      ["c-near", "near"],
      ["c-far", "far"],
    ]);
  });

  it("applies the daily limit of new cards to each plan on its own", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    addPlan(db, "b", { examIn: 9 });
    for (const id of ["a1", "a2", "a3"]) dueCard(db, id, "a", "a-t0");
    for (const id of ["b1", "b2", "b3"]) dueCard(db, id, "b", "b-t0");
    setNewCardsPerDay(db, 2, now);
    const cards = dueEverywhere(db, now);
    expect(cards.map((card) => card.planId)).toEqual(["a", "a", "b", "b"]);
    expect(todayPlan(db, now).cards?.due).toBe(4);
  });

  it("serves and counts flashcards with no exam after the dated exams, before a past one, each subject on its own", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "near", { examIn: 4 });
    addPlan(db, "past", { examIn: -1 });
    dueCard(db, "c-near", "near", "near-t0");
    dueCard(db, "c-past", "past", "past-t0");
    db.exec(`INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 2', 1);
      INSERT INTO cards (id, subject_id, front, back, created_at) VALUES ('c-free', 'phys', 'Campo', 'E', 1),
        ('c-gone', 'phys', 'Rimossa', 'x', 1);
      UPDATE cards SET removed = 1 WHERE id = 'c-gone';`);
    expect(dueEverywhere(db, now).map((card) => [card.id, card.planId, card.subject])).toEqual([
      ["c-near", "near", null],
      ["c-free", null, "Fisica 2"],
      ["c-past", "past", null],
    ]);
    expect(todayPlan(db, now).cards).toEqual({ due: 3, plans: 2, ratedToday: 0 });
    rateCard(db, "c-free", "good", now);
    expect(todayPlan(db, now).cards).toEqual({ due: 2, plans: 2, ratedToday: 1 });
  });
});

describe("flashcards due with no exam", () => {
  it("counts the ones the daily review adds to the exams' own, with or without an exam", () => {
    const db = openDatabase(":memory:");
    expect(examlessDue(db, now)).toBe(0);
    db.exec(`INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 2', 1), ('chem', 'Chimica', 1);
      INSERT INTO cards (id, subject_id, front, back, created_at) VALUES ('c1', 'phys', 'Campo', 'E', 1),
        ('c2', 'chem', 'Mole', 'n', 1), ('c-gone', 'phys', 'Rimossa', 'x', 1);
      UPDATE cards SET removed = 1 WHERE id = 'c-gone';`);
    // No exam at all: the review still has these two.
    expect(examlessDue(db, now)).toBe(2);
    expect(todayPlan(db, now).cards?.due).toBe(2);
    // An exam's own card is not counted here, and rating one of the two takes it out.
    addPlan(db, "near", { examIn: 4 });
    dueCard(db, "c-near", "near", "near-t0");
    expect(examlessDue(db, now)).toBe(2);
    expect(todayPlan(db, now).cards?.due).toBe(3);
    rateCard(db, "c1", "good", now);
    expect(examlessDue(db, now)).toBe(1);
  });
});

describe("exam rings", () => {
  const ringOf = (db: Db, id: string) => examRings(db, now).find((ring) => ring.planId === id)!;

  it("shows no preparation until something is measured, then the exam list's mastery", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    expect(ringOf(db, "a").preparation).toBeNull();
    // A lesson read measures nothing.
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 9));
    expect(ringOf(db, "a").preparation).toBeNull();
    recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(0, 9));
    expect(ringOf(db, "a").preparation).toBe(0);
  });

  it("counts a wrong quick-check answer as measured, at zero", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    // What a wrong answer to a lesson's quick check records: evidence with score 0 and no graded step.
    appendEvent(db, {
      kind: "answer_given",
      planId: "a",
      topicId: "a-t0",
      payload: { blockId: "q1", pick: 1, shown: true, score: 0, evidenceKind: "check" },
      at: day(0, 9),
    });
    expect(ringOf(db, "a").preparation).toBe(0);
  });

  it("counts the path in the planner's minutes of work, from nothing studied to the target", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    // Nothing studied: 15 diagnostic + 2 * (30 lesson + 3 * 20) + 60 simulation = 255 minutes left of 255.
    expect(ringOf(db, "a").path).toBe(0);
    // A lesson read ends the start (15) and the lesson (30): 210 left.
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(-1));
    expect(ringOf(db, "a").path).toBeCloseTo(45 / 255);
  });

  it("has no path for an exam without topics", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4, topics: 0 });
    expect(ringOf(db, "a").path).toBeNull();
  });

  it("counts one step as today's work when no weekly hours are set", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    addPlan(db, "undated");
    expect(ringOf(db, "a").today).toBe(0);
    expect(ringOf(db, "undated").today).toBe(0);
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 9));
    expect(ringOf(db, "a").today).toBe(1);
    // A step yesterday is not today's.
    recordStep(db, "undated", { activity: "lesson", topicId: "undated-t0" }, day(-1));
    expect(ringOf(db, "undated").today).toBe(0);
  });

  it("counts today's minutes against the planner's share with weekly hours", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    // 3.5 h a week gives the exam 30 minutes today; exercises take 20.
    savePlannerHours(db, { hours: 3.5 }, now);
    recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(0, 9));
    expect(ringOf(db, "a").today).toBeCloseTo(20 / 30);
    recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(0, 10));
    expect(ringOf(db, "a").today).toBe(1);
  });

  it("plans nothing today for a share too small to ask for, a past exam or an archived one", () => {
    const db = openDatabase(":memory:");
    for (const id of ["a", "b", "c", "d"]) addPlan(db, id, { examIn: 4 });
    addPlan(db, "past", { examIn: -2 });
    addPlan(db, "old", { examIn: 3 });
    db.prepare("UPDATE plans SET archived_at = 1 WHERE id = 'old'").run();
    dueCard(db, "c1", "old", "old-t0");
    savePlannerHours(db, { hours: 0.5 }, now);
    expect(ringOf(db, "a").today).toBeNull();
    expect(ringOf(db, "past").today).toBeNull();
    // A past exam keeps its path and its preparation.
    expect(ringOf(db, "past").path).toBe(0);
    const old = ringOf(db, "old");
    expect(old.today).toBeNull();
    expect(old.dueCards).toBe(0);
    expect(examRings(db, now).at(-1)!.planId).toBe("old");
  });

  it("names the next step without due cards and counts each exam's due cards", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    dueCard(db, "c1", "a", "a-t0");
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(-1));
    const ring = ringOf(db, "a");
    expect(ring.dueCards).toBe(1);
    expect(ring.next?.activity).not.toBe("cards");
    expect(ring.next?.topicTitle).toBe(ring.next?.topicId ? `Topic ${ring.next.topicId.slice(-1)} of a` : null);
  });

  it("leaves out an exam still building", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    db.prepare("UPDATE plans SET status = 'building' WHERE id = 'a'").run();
    expect(examRings(db, now)).toEqual([]);
  });
});
