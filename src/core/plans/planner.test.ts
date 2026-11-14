import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { appendEvent } from "../events";
import { rateCard, setNewCardsPerDay } from "../study/cards";
import { readSteps, recordStep } from "./steps";
import { planGuide, pathState } from "./create";
import { markPartDone } from "../study/partProgress";
import { seedOutline } from "../study/test-parts";
import { dayKey, startOfWeek } from "../../shared/local-day";
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
  todayGoals,
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

  it("counts an unread lesson in parts by the minutes of its parts not done, and any other unread lesson as 30", () => {
    const topics = [
      { id: "a", mastery: 0, partMinutes: { total: 22, left: 15 } },
      { id: "b", mastery: 0 },
    ];
    const steps = [{ activity: "diagnostic" as const, topicId: null }];
    expect(remainingWork({ topics, steps, hasIntro: false, target: 0.75 })).toEqual([
      { kind: "topic", topicId: "a", minutes: 15 + 60 },
      { kind: "topic", topicId: "b", minutes: 30 + 60 },
      { kind: "simulation", topicId: null, minutes: 60 },
    ]);
    // Once its lesson is read, a topic in parts has only its activities left, like any other.
    expect(
      remainingWork({ topics, steps: [...steps, { activity: "lesson", topicId: "a" }], hasIntro: false, target: 0.75 })[0],
    ).toEqual({ kind: "topic", topicId: "a", minutes: 60 });
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

  it("never ticks a plan off without weekly hours, however many steps are done today", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 9));
    recordStep(db, "a", { activity: "lesson", topicId: "a-t1" }, day(0, 10));
    const item = todayPlan(db, now).items[0]!;
    expect(item.complete).toBe(false);
    expect(item.minutesToday).toBeNull();
    expect(item.done.map((step) => step.topicId)).toEqual(["a-t0", "a-t1"]);
  });

  it("ticks a plan off once today's steps cover its part of the goal for the day", () => {
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

  it("narrows the review to one exam's due cards, and to those with no topic", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    addPlan(db, "b", { examIn: 9 });
    dueCard(db, "a1", "a", "a-t0");
    dueCard(db, "b1", "b", "b-t0");
    db.exec(`INSERT INTO cards (id, plan_id, front, back, created_at) VALUES ('b-loose', 'b', 'Loose', 'x', 2)`);
    expect(dueEverywhere(db, now, { planId: "b" }).map((card) => card.id)).toEqual(["b1", "b-loose"]);
    expect(dueEverywhere(db, now, { planId: "b", noTopic: true }).map((card) => [card.id, card.planId])).toEqual([
      ["b-loose", "b"],
    ]);
    expect(dueEverywhere(db, now, { planId: "a" }).map((card) => card.id)).toEqual(["a1"]);
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

  it("leaves Oggi unmeasured on a new exam with only the introduction done and no weekly hours", () => {
    // What Tost saw on dev.9: a few seconds on the introduction filled the ring for the whole day.
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 64 });
    db.prepare("INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('intro', 'a', 'intro', '{}', 1)").run();
    recordStep(db, "a", { activity: "intro", topicId: null }, day(0, 9));
    const ring = ringOf(db, "a");
    expect(ring.today).toBeNull();
    expect(ring.todayMinutes).toBeNull();
    expect(ring.todayUnmeasured).toBe("no-goal");
  });

  it("never fills Oggi with one step when no weekly hours are set, with or without a date", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    addPlan(db, "undated");
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 9));
    recordStep(db, "undated", { activity: "lesson", topicId: "undated-t0" }, day(0, 9));
    for (const id of ["a", "undated"]) {
      expect(ringOf(db, id).today).toBeNull();
      expect(ringOf(db, id).todayUnmeasured).toBe("no-goal");
    }
    // Oggi's own list agrees: nothing ticks off without a goal.
    expect(todayPlan(db, now).items.every((item) => !item.complete)).toBe(true);
  });

  it("starts measuring once weekly hours are set, from nothing done", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    savePlannerHours(db, { hours: 3.5 }, now);
    const ring = ringOf(db, "a");
    expect(ring.today).toBe(0);
    expect(ring.todayUnmeasured).toBeNull();
  });

  it("says why Oggi is unmeasured with weekly hours: no date, or the exam is today", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "undated");
    addPlan(db, "today", { examIn: 0 });
    addPlan(db, "past", { examIn: -2 });
    savePlannerHours(db, { hours: 7 }, now);
    recordStep(db, "undated", { activity: "lesson", topicId: "undated-t0" }, day(0, 9));
    expect(ringOf(db, "undated")).toMatchObject({ today: null, todayUnmeasured: "no-date" });
    expect(ringOf(db, "today")).toMatchObject({ today: null, todayUnmeasured: "exam-day" });
    expect(ringOf(db, "past")).toMatchObject({ today: null, todayUnmeasured: null });
  });

  it("counts today's minutes against the goal for the day with weekly hours", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    // 3.5 h a week is 30 minutes a day, and the exam is the only one; exercises take 20.
    savePlannerHours(db, { hours: 3.5 }, now);
    recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(0, 9));
    expect(ringOf(db, "a").today).toBeCloseTo(20 / 30);
    expect(ringOf(db, "a").todayMinutes).toEqual({ done: 20, target: 30 });
    recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(0, 10));
    expect(ringOf(db, "a").today).toBe(1);
  });

  describe("Oggi's target is the student's goal, not the planner's pace", () => {
    const withIntro = (db: Db, id: string, examIn: number) => {
      addPlan(db, id, { examIn });
      db.prepare(
        "INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES (?, ?, 'intro', '{}', 1)",
      ).run(`intro-${id}`, id);
    };

    it("reads 10 of 51 minutes, not full, after only the introduction with 6 hours a week and the exam 64 days away", () => {
      // What Tost saw on dev.10: the planner's pace for this exam is about 8 minutes a day, so the introduction alone
      // filled the ring. The goal is a seventh of 6 hours, 51 minutes.
      const db = openDatabase(":memory:");
      withIntro(db, "a", 64);
      savePlannerHours(db, { hours: 6 }, now);
      recordStep(db, "a", { activity: "intro", topicId: null }, day(0, 9));
      const ring = ringOf(db, "a");
      expect(ring.todayMinutes).toEqual({ done: 10, target: 51 });
      expect(ring.today).toBeCloseTo(10 / ((6 * 60) / 7));
      expect(ring.today).toBeLessThan(1);
      // Oggi's list asks the same of the exam.
      expect(todayPlan(db, now).items[0]).toMatchObject({ complete: false, minutesToday: 50 });
    });

    it("gives each of two exams its part of the goal: 10 of 26 minutes for two alike", () => {
      const db = openDatabase(":memory:");
      withIntro(db, "a", 64);
      withIntro(db, "b", 64);
      savePlannerHours(db, { hours: 6 }, now);
      recordStep(db, "a", { activity: "intro", topicId: null }, day(0, 9));
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 10, target: 26 });
      expect(ringOf(db, "a").today).toBeLessThan(1);
      expect(ringOf(db, "b").todayMinutes).toEqual({ done: 0, target: 26 });
    });

    it("is full once today's steps reach the goal, within 2.5 minutes, and not before", () => {
      const db = openDatabase(":memory:");
      withIntro(db, "a", 64);
      savePlannerHours(db, { hours: 6 }, now);
      // A lesson (30) and exercises (20) make 50 of 51: inside the tolerance.
      recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 9));
      expect(ringOf(db, "a").today).toBeLessThan(1);
      recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(0, 10));
      expect(ringOf(db, "a")).toMatchObject({ today: 1, todayMinutes: { done: 50, target: 51 } });
    });

    it("takes this week's own hours over the usual ones", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      savePlannerHours(db, { hours: 6 }, now);
      savePlannerHours(db, { week: dayKey(startOfWeek(now)), hours: 3.5 }, now);
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 0, target: 30 });
    });

    it("splits the goal in proportion to the pace each exam needs, and gives none to one with nothing left", () => {
      const exams = [
        { id: "far", examDay: 60, remaining: 240 },
        { id: "near", examDay: 30, remaining: 240 },
        { id: "done", examDay: 10, remaining: 0 },
      ];
      const goals = todayGoals(exams, 60);
      expect(goals.get("far")).toBeCloseTo(20);
      expect(goals.get("near")).toBeCloseTo(40);
      expect(goals.has("done")).toBe(false);
      expect([...goals.values()].reduce((sum, value) => sum + value, 0)).toBeCloseTo(60);
      expect(todayGoals([exams[0]!], 51).get("far")).toBeCloseTo(51);
    });
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

  it("names the same next step as the exam's page, which also leaves the due cards to their own line", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    dueCard(db, "c1", "a", "a-t1");
    recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(-1));
    recordStep(db, "a", { activity: "practice", topicId: "a-t0" }, day(-1));
    const listed = ringOf(db, "a").next;
    const page = planGuide(db, "a", now)?.next;
    expect(listed).toEqual({ activity: "quiz", topicId: "a-t0", topicTitle: "Topic 0 of a" });
    expect(page).toMatchObject({ activity: listed?.activity, topicId: listed?.topicId });
    expect(ringOf(db, "a").dueCards).toBe(1);
  });

  describe("a lesson in parts", () => {
    /**
     * Parts of 6, 5 and 7 minutes and a recap of 4 on a topic, each written without a question, so "Fatto" finishes
     * each and the lesson step names part 1's text.
     */
    const withParts = (db: Db, createdAt = day(-3), topicId = "a-t0", id?: string) =>
      seedOutline(db, {
        planId: "a",
        topicId,
        id,
        createdAt,
        parts: [6, 5, 7, 4].map((minutes, index) => ({
          minutes,
          kind: index === 3 ? ("recap" as const) : ("part" as const),
          markdown: `## Parte ${index + 1}\n\nUn testo senza domanda.`,
        })),
      });
    const done = (db: Db, position: number, at: number) => markPartDone(db, { planId: "a", topicId: "a-t0", position }, at);

    it("counts the minutes of the parts done since the start of the local day, and no lesson minutes on top", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      withParts(db);
      // 6 hours a week: the goal is 51 minutes a day.
      savePlannerHours(db, { hours: 6 }, now);
      done(db, 1, day(-1, 23));
      done(db, 2, day(0, 0));
      // Only the part done after midnight counts, and one short part does not fill the day.
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 5, target: 51 });
      expect(ringOf(db, "a").today).toBeCloseTo(5 / ((6 * 60) / 7));
      done(db, 3, day(0, 9));
      // The recap is the last part missing: it records the lesson step, which adds nothing to the parts' 5 + 7 + 4.
      expect(done(db, 4, day(0, 9))).toEqual({ partDone: true, finished: true });
      expect(ringOf(db, "a")).toMatchObject({ todayMinutes: { done: 16, target: 51 } });
      expect(ringOf(db, "a").today).toBeLessThan(1);
      expect(todayPlan(db, now).items[0]).toMatchObject({
        complete: false,
        minutesLeft: 35,
        done: [{ activity: "lesson", topicId: "a-t0", topicTitle: "Topic 0 of a" }],
      });
      db.close();
    });

    it("adds nothing for the lesson step when the parts were read recap first and the last one a day later", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      withParts(db);
      savePlannerHours(db, { hours: 6 }, now);
      // Yesterday: the recap, then parts 2 and 3. No lesson step yet, so nothing but the parts' own minutes counts.
      for (const position of [4, 2, 3]) expect(done(db, position, day(-1, 9))).toEqual({ partDone: true, finished: false });
      expect(readSteps(db, "a").filter((step) => step.activity === "lesson")).toEqual([]);
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 0, target: 51 });
      // Today: part 1 is the last one missing. It records the step, which adds nothing to its 6 minutes.
      expect(done(db, 1, day(0, 9))).toEqual({ partDone: true, finished: true });
      expect(readSteps(db, "a").filter((step) => step.activity === "lesson")).toHaveLength(1);
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 6, target: 51 });
      db.close();
    });

    it("measures the day once a part alone was done, and fills it once the parts reach the goal", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      withParts(db);
      // 1.5 hours a week is about 13 minutes a day: 6 and 5 minutes are 11, within the 2.5 minutes Oggi allows.
      savePlannerHours(db, { hours: 1.5 }, now);
      done(db, 1, day(0, 8));
      expect(ringOf(db, "a").today).toBeCloseTo(6 / ((1.5 * 60) / 7));
      done(db, 2, day(0, 9));
      expect(ringOf(db, "a")).toMatchObject({ today: 1, todayMinutes: { done: 11, target: 13 } });
      expect(todayPlan(db, now).items[0]).toMatchObject({ complete: true, done: [] });
      db.close();
    });

    it("keeps a lesson's 30 minutes when it was read whole before its topic got parts", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      savePlannerHours(db, { hours: 6 }, now);
      recordStep(db, "a", { activity: "lesson", topicId: "a-t0" }, day(0, 8));
      withParts(db, day(0, 9));
      done(db, 1, day(0, 9));
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 36, target: 51 });
      db.close();
    });

    it("keeps today's minutes when the outline is replaced after its lesson was finished in parts", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      withParts(db);
      savePlannerHours(db, { hours: 6 }, now);
      for (const position of [1, 2, 3, 4]) done(db, position, day(0, 9));
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 22, target: 51 });
      // "Riscrivi in parti" half an hour later: the first outline is retired and a newer one is live.
      db.prepare("UPDATE lesson_outlines SET retired_at = ? WHERE topic_id = 'a-t0'").run(day(0, 9) + 30 * 60_000);
      withParts(db, day(0, 9) + 30 * 60_000, "a-t0", "again");
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 22, target: 51 });
      db.close();
    });

    it("gives a lesson read whole its 30 minutes also when its topic already has an outline", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      savePlannerHours(db, { hours: 6 }, now);
      withParts(db, day(0, 8));
      db.prepare(
        "INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, created_at) VALUES ('old', 'a', 'a-t0', 'lesson', '{\"markdown\":\"Tutto\"}', 'claude', 1)",
      ).run();
      recordStep(db, "a", { activity: "lesson", topicId: "a-t0", itemId: "old" }, day(0, 9));
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 30, target: 51 });
      // "Fatto" on a lesson that names no item gets the topic's newest lesson that is not a part, here none.
      withParts(db, day(-3), "a-t1");
      recordStep(db, "a", { activity: "lesson", topicId: "a-t1" }, day(0, 10));
      expect(readSteps(db, "a").find((step) => step.topicId === "a-t1")?.itemId).toBeNull();
      expect(ringOf(db, "a").todayMinutes).toEqual({ done: 60, target: 51 });
      db.close();
    });

    it("moves the path ring by each part's minutes, from all the parts' minutes with nothing studied", () => {
      const db = openDatabase(":memory:");
      addPlan(db, "a", { examIn: 64 });
      withParts(db);
      // 15 diagnostic + (22 parts + 3 * 20) + (30 lesson + 3 * 20) + 60 simulation = 247.
      expect(ringOf(db, "a").path).toBe(0);
      done(db, 1, day(0, 9));
      expect(ringOf(db, "a").path).toBeCloseTo(6 / 247);
      for (const position of [2, 3, 4]) done(db, position, day(0, 9));
      // The lesson read ends the start too: 15 + 22 of 247.
      expect(ringOf(db, "a").path).toBeCloseTo(37 / 247);
      db.close();
    });

    it("leaves a topic without parts as it was, whether another topic has parts or not", () => {
      const results = [false, true].map((outline) => {
        const db = openDatabase(":memory:");
        addPlan(db, "a", { examIn: 64 });
        if (outline) withParts(db);
        savePlannerHours(db, { hours: 6 }, now);
        recordStep(db, "a", { activity: "lesson", topicId: "a-t1" }, day(0, 9));
        const ring = ringOf(db, "a");
        const item = todayPlan(db, now).items[0];
        const piece = remainingWork(pathState(db, "a", now)!).find((work) => work.topicId === "a-t1");
        db.close();
        return { today: ring.today, todayMinutes: ring.todayMinutes, item, piece };
      });
      expect(results[1]).toEqual(results[0]);
      expect(results[0]!.todayMinutes).toEqual({ done: 30, target: 51 });
      expect(results[0]!.piece).toEqual({ kind: "topic", topicId: "a-t1", minutes: 60 });
    });
  });

  it("leaves out an exam still building", () => {
    const db = openDatabase(":memory:");
    addPlan(db, "a", { examIn: 4 });
    db.prepare("UPDATE plans SET status = 'building' WHERE id = 'a'").run();
    expect(examRings(db, now)).toEqual([]);
  });
});
