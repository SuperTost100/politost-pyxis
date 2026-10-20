import type Database from "better-sqlite3";
import { z } from "zod";
import { suggestStep, stayActivities, type Activity, type Step, type TopicStatus } from "./path";
import { daysUntil, pathState } from "./create";
import { countDueCards, dueCards } from "../study/cards";
import { weightedPlanMastery } from "./progress";

/**
 * The session planner and Oggi. See "Session planner" in docs/mastery.md: remaining work is an estimate in minutes from
 * what the path knows (unread lessons, topics below the target, a simulation not yet done), and each exam's work is
 * spread evenly over the days before it, within the hours the student has. Everything is computed again from the
 * current state on every read, so a missed day re-plans the rest.
 */

/** Minutes one step of each kind takes, for the estimate. Cards are review, outside the planned work. */
export const stepMinutes: Record<Activity, number> = {
  intro: 10,
  diagnostic: 15,
  lesson: 30,
  practice: 20,
  quiz: 20,
  gaps: 20,
  cards: 0,
  simulation: 60,
};

/** Plans Oggi and the planner look at: every built plan that is not archived. */
const studyPlans = `SELECT id, title, exam_at, target, updated_at,
  (SELECT name FROM subjects s WHERE s.id = p.subject_id) AS subject
  FROM plans p WHERE status <> 'building' AND archived_at IS NULL`;

type PlanRow = {
  id: string;
  title: string;
  exam_at: number | null;
  target: number;
  updated_at: number;
  subject: string | null;
};

const plannerKey = "planner";

export const plannerSettings = z.object({
  weeklyHours: z.number().min(0).max(100).nullable(),
  /** Hours for one week, keyed by the date of its Monday (YYYY-MM-DD); they replace weeklyHours for that week. */
  weeks: z.record(z.string(), z.number().min(0).max(100)),
});
export type PlannerSettings = z.infer<typeof plannerSettings>;

export function readPlannerSettings(db: Database.Database): PlannerSettings {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(plannerKey) as
    | { value_json: string }
    | undefined;
  const parsed = row ? plannerSettings.safeParse(JSON.parse(row.value_json)) : null;
  return parsed?.success ? parsed.data : { weeklyHours: null, weeks: {} };
}

/** Sets the usual hours a week, or with `week` the hours of that one week; null clears that week's own value. */
export function savePlannerHours(
  db: Database.Database,
  input: { week?: string; hours: number | null },
  now = Date.now(),
): { ok: true } {
  const current = readPlannerSettings(db);
  const next: PlannerSettings = { weeklyHours: current.weeklyHours, weeks: { ...current.weeks } };
  if (!input.week) next.weeklyHours = input.hours;
  else if (input.hours == null) delete next.weeks[input.week];
  else next.weeks[input.week] = input.hours;
  // Weeks already over are not read again.
  const thisWeek = dayKey(monday(now));
  next.weeks = Object.fromEntries(Object.entries(next.weeks).filter(([week]) => week >= thisWeek));
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(plannerKey, JSON.stringify(plannerSettings.parse(next)), now);
  return { ok: true };
}

const startOfDay = (at: number) => new Date(at).setHours(0, 0, 0, 0);
const addDays = (at: number, days: number) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};
const monday = (at: number) => addDays(startOfDay(at), -((new Date(at).getDay() + 6) % 7));
export const dayKey = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/**
 * The minutes of work a plan has left, from the path's view of it: the introduction and diagnostic while nothing was
 * studied, a lesson for each unread topic, graded activities for each topic below the target, and one simulation until
 * one is done. A topic at zero mastery needs `stayActivities` (3) graded activities; one part of the way there needs
 * that share of them, rounded up.
 */
export function remainingMinutes(input: {
  topics: Array<Pick<TopicStatus, "id" | "mastery">>;
  steps: Array<Pick<Step, "activity" | "topicId">>;
  hasIntro: boolean;
  target: number;
}): number {
  const done = (activity: Activity) => input.steps.some((step) => step.activity === activity);
  const read = new Set(
    input.steps.filter((step) => step.activity === "lesson").map((step) => step.topicId),
  );
  const studied =
    input.steps.some((step) => step.activity !== "intro" && step.activity !== "diagnostic") ||
    input.topics.some((topic) => topic.mastery > 0);
  let minutes = 0;
  if (!studied && !done("diagnostic") && input.topics.length) {
    minutes += stepMinutes.diagnostic;
    if (input.hasIntro && !done("intro")) minutes += stepMinutes.intro;
  }
  for (const topic of input.topics) {
    if (topic.mastery >= input.target) continue;
    if (!read.has(topic.id)) minutes += stepMinutes.lesson;
    const share = (input.target - topic.mastery) / input.target;
    minutes += Math.ceil(stayActivities * share - 1e-9) * stepMinutes.quiz;
  }
  if (input.topics.length && !done("simulation")) minutes += stepMinutes.simulation;
  return minutes;
}

export type SpreadExam = {
  id: string;
  /** Days from today to the exam; the exam day itself gets no study time. At least 1. */
  examDay: number;
  /** Minutes of work at the start of today. */
  remaining: number;
};

/**
 * Spreads each exam's work evenly over the days before it. Each day an exam needs a pace: its work left over the days
 * left before it. When the day's minutes cover every pace, each exam gets its pace and the rest of the time stays free;
 * when they do not, every exam gets the same share of its pace and falls behind. Returns the minutes per exam for each
 * day from today, and the work each exam still has on its exam day.
 */
export function spread(
  exams: SpreadExam[],
  capacity: (day: number) => number,
): { days: Array<Map<string, number>>; left: Map<string, number> } {
  const left = new Map(exams.map((exam) => [exam.id, exam.remaining]));
  const last = Math.max(0, ...exams.map((exam) => exam.examDay));
  const days: Array<Map<string, number>> = [];
  for (let day = 0; day < last; day += 1) {
    const need = new Map(
      exams
        .filter((exam) => exam.examDay > day && left.get(exam.id)! > 0)
        .map((exam) => [exam.id, left.get(exam.id)! / (exam.examDay - day)]),
    );
    const total = [...need.values()].reduce((sum, value) => sum + value, 0);
    const scale = total > 0 ? Math.min(1, capacity(day) / total) : 0;
    const given = new Map<string, number>();
    for (const [id, pace] of need) {
      given.set(id, pace * scale);
      left.set(id, left.get(id)! - pace * scale);
    }
    days.push(given);
  }
  return { days, left };
}

/**
 * The hours a week that would bring every exam to its target on time: for each exam, the work of it and every earlier
 * exam over the days before it, and the largest of those paces. Rounded up to the half hour.
 */
export function neededHours(exams: SpreadExam[]): number {
  let pace = 0;
  for (const exam of exams) {
    const work = exams
      .filter((other) => other.examDay <= exam.examDay)
      .reduce((sum, other) => sum + other.remaining, 0);
    pace = Math.max(pace, work / exam.examDay);
  }
  return Math.ceil(((pace * 7) / 60) * 2) / 2;
}

type PlanState = NonNullable<ReturnType<typeof pathState>>;

function studyState(db: Database.Database, now: number) {
  const today = startOfDay(now);
  const rows = db.prepare(`${studyPlans} ORDER BY updated_at DESC`).all() as PlanRow[];
  const passages = db.prepare(
    "SELECT t.id, count(tp.passage_id) AS n FROM topics t LEFT JOIN topic_passages tp ON tp.topic_id = t.id WHERE t.plan_id = ? GROUP BY t.id",
  );
  return rows.flatMap((row) => {
    const state = pathState(db, row.id, now);
    if (!state) return [];
    const doneToday = state.steps.filter((step) => step.at >= today && step.activity !== "cards");
    const remainingNow = remainingMinutes(state);
    const doneMinutes = doneToday.reduce((sum, step) => sum + stepMinutes[step.activity], 0);
    // The mastery the exam list shows, weighted by passages.
    const mastery = weightedPlanMastery(
      state.topics,
      new Map(
        (passages.all(row.id) as Array<{ id: string; n: number }>).map((topic) => [topic.id, topic.n]),
      ),
    );
    return [
      {
        row,
        state,
        doneToday,
        doneMinutes,
        // The plan is laid out from the start of today, so studying today does not move today's share.
        remaining: remainingNow + doneMinutes,
        remainingNow,
        mastery,
      },
    ];
  });
}

type Studied = ReturnType<typeof studyState>[number];

function layout(db: Database.Database, plans: Studied[], now: number) {
  const settings = readPlannerSettings(db);
  const today = startOfDay(now);
  const dated = plans
    .filter((plan) => plan.state.daysToExam != null && plan.state.daysToExam > 0)
    .sort((a, b) => a.state.daysToExam! - b.state.daysToExam!);
  const exams: SpreadExam[] = dated.map((plan) => ({
    id: plan.row.id,
    examDay: plan.state.daysToExam!,
    remaining: plan.remaining,
  }));
  const weekHours = (start: number) => {
    const key = dayKey(start);
    return key in settings.weeks ? settings.weeks[key]! : settings.weeklyHours;
  };
  const planned = settings.weeklyHours != null || Object.keys(settings.weeks).length > 0;
  const result = planned
    ? spread(exams, (day) => ((weekHours(monday(addDays(today, day))) ?? 0) * 60) / 7)
    : null;
  return { settings, dated, exams, weekHours, result, today };
}

/** Round minutes for display, to the nearest 5. */
const round5 = (minutes: number) => Math.round(minutes / 5) * 5;

/**
 * One dated exam in the planner. It is behind when work is left on its exam day; at the pace it got, it would reach its
 * target this many days later, and by the exam it gets the same share of the way from its mastery to the target as the
 * share of the work it got done.
 */
function examView(
  plan: Studied,
  exams: SpreadExam[],
  result: ReturnType<typeof spread> | null,
  today: number,
) {
  const exam = exams.find((item) => item.id === plan.row.id)!;
  const left = result?.left.get(plan.row.id) ?? 0;
  const given = exam.remaining - left;
  const pace = given / exam.examDay;
  const share = exam.remaining > 0 ? given / exam.remaining : 1;
  return {
    planId: plan.row.id,
    title: plan.row.title,
    subject: plan.row.subject,
    examDate: dayKey(addDays(today, exam.examDay)),
    daysToExam: exam.examDay,
    mastery: plan.mastery,
    target: plan.row.target,
    remainingMinutes: round5(plan.remainingNow),
    behind:
      result && left >= 5
        ? {
            daysLate: pace > 0 ? Math.ceil(left / pace) : null,
            masteryAtExam: Math.max(
              plan.mastery,
              plan.mastery + (plan.state.target - plan.mastery) * share,
            ),
          }
        : null,
  };
}

/** The session plan: every dated exam, its work left, and that work spread over the weeks and days before it. */
export function sessionPlan(db: Database.Database, now = Date.now()) {
  const plans = studyState(db, now);
  const { settings, dated, exams, weekHours, result, today } = layout(db, plans, now);
  const last = Math.max(0, ...exams.map((exam) => exam.examDay));
  const examOn = new Map<number, string[]>();
  for (const exam of exams) examOn.set(exam.examDay, [...(examOn.get(exam.examDay) ?? []), exam.id]);
  const days = result
    ? Array.from({ length: last + 1 }, (_, day) => ({
        date: dayKey(addDays(today, day)),
        plans: [...(result.days[day] ?? new Map<string, number>())]
          .map(([planId, minutes]) => ({ planId, minutes: round5(minutes) }))
          .filter((entry) => entry.minutes > 0),
        exams: examOn.get(day) ?? [],
      }))
    : [];
  const weeks: Array<{
    start: string;
    hours: number;
    custom: boolean;
    plans: Array<{ planId: string; minutes: number }>;
    exams: string[];
  }> = [];
  if (result)
    for (let start = monday(today); start <= addDays(today, last); start = addDays(start, 7)) {
      const minutes = new Map<string, number>();
      const examsInWeek: string[] = [];
      for (let day = 0; day <= last; day += 1) {
        const date = addDays(today, day);
        if (date < start || date >= addDays(start, 7)) continue;
        for (const [planId, value] of result.days[day] ?? [])
          minutes.set(planId, (minutes.get(planId) ?? 0) + value);
        examsInWeek.push(...(examOn.get(day) ?? []));
      }
      weeks.push({
        start: dayKey(start),
        hours: weekHours(start) ?? 0,
        custom: dayKey(start) in settings.weeks,
        plans: [...minutes]
          .map(([planId, value]) => ({ planId, minutes: round5(value) }))
          .filter((entry) => entry.minutes > 0),
        exams: examsInWeek,
      });
    }
  return {
    weeklyHours: settings.weeklyHours,
    neededHours: exams.length ? neededHours(exams) : null,
    exams: dated.map((plan) => examView(plan, exams, result, today)),
    weeks,
    days,
  };
}

/** Oggi lists due flashcards as one item, then one item per plan; this is the plan item's next step. */
function nextStep(state: PlanState) {
  // Due cards from every plan are their own item, so here the path looks past them.
  return suggestStep({
    topics: state.topics.map((topic) => ({ ...topic, dueCards: 0 })),
    steps: state.steps,
    hasIntro: state.hasIntro,
    target: state.target,
    daysToExam: state.daysToExam,
  });
}

/**
 * Today's study across every exam: due flashcards from all plans as one item, then each plan's next step, the closest
 * exam first and plans without a date after the dated ones. With hours set in the planner, a plan's item is done once
 * today's steps cover the minutes the planner gave it today (at least one step), and a plan the planner gave under
 * 2.5 minutes today is left out unless it was studied today. Without hours, one step a day finishes a plan's item.
 * Exams already past are left out.
 */
export function todayPlan(db: Database.Database, now = Date.now()) {
  const plans = studyState(db, now);
  const { dated, exams, result, today } = layout(db, plans, now);
  const dueByPlan = plans.map((plan) => countDueCards(db, plan.row.id, now));
  const due = dueByPlan.reduce((sum, count) => sum + count, 0);
  const rated = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM card_reviews r JOIN cards c ON c.id = r.card_id
         WHERE r.reviewed_at >= ? AND c.plan_id IN (SELECT id FROM (${studyPlans}))`,
      )
      .get(today) as { n: number }
  ).n;
  const titles = db.prepare("SELECT title FROM topics WHERE id = ?");
  const topicTitle = (topicId: string | null) =>
    topicId ? ((titles.get(topicId) as { title: string } | undefined)?.title ?? null) : null;
  const items = plans
    .filter((plan) => plan.state.daysToExam == null || plan.state.daysToExam >= 0)
    .flatMap((plan) => {
      const next = nextStep(plan.state);
      const days = plan.state.daysToExam;
      const inPlan = result != null && days != null && days > 0;
      const minutes = inPlan ? (result.days[0]?.get(plan.row.id) ?? 0) : null;
      // An allocation under the 2.5 minute tolerance is too small to ask for and would tick off with no work done.
      if (minutes != null && minutes < 2.5 && plan.doneToday.length === 0) return [];
      if (!next && plan.doneToday.length === 0) return [];
      const complete =
        plan.doneToday.length > 0 && (minutes == null || plan.doneMinutes >= minutes - 2.5);
      return [
        {
          planId: plan.row.id,
          title: plan.row.title,
          subject: plan.row.subject,
          daysToExam: days,
          next: next
            ? {
                activity: next.activity,
                topicId: next.topicId,
                topicTitle: topicTitle(next.topicId),
                reason: next.reason,
              }
            : null,
          done: plan.doneToday.map((step) => ({
            activity: step.activity,
            topicId: step.topicId,
            topicTitle: topicTitle(step.topicId),
          })),
          minutesToday: minutes == null ? null : round5(minutes),
          minutesLeft: minutes == null ? null : round5(Math.max(0, minutes - plan.doneMinutes)),
          complete,
        },
      ];
    })
    // Plans come most recently changed first, and the sort is stable, so that order breaks ties.
    .sort(
      (a, b) =>
        (a.daysToExam == null ? 1 : 0) - (b.daysToExam == null ? 1 : 0) ||
        (a.daysToExam ?? 0) - (b.daysToExam ?? 0),
    );
  return {
    planned: result != null,
    behind: dated
      .map((plan) => examView(plan, exams, result, today))
      .filter((exam) => exam.behind != null),
    cards:
      due > 0 || rated > 0
        ? { due, plans: dueByPlan.filter((count) => count > 0).length, ratedToday: rated }
        : null,
    items,
  };
}

/**
 * Due flashcards from every plan for Oggi's one cards item: the closest exam's cards first, plans without a date after
 * the dated ones and past exams last; at most 20 at a time, like a plan's own session.
 */
export function dueEverywhere(db: Database.Database, now = Date.now()) {
  const today = startOfDay(now);
  const rows = db.prepare(studyPlans).all() as PlanRow[];
  const rank = (row: PlanRow) =>
    row.exam_at == null ? 1 : startOfDay(row.exam_at) < today ? 2 : 0;
  const ordered = rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.exam_at ?? 0) - (b.exam_at ?? 0) ||
      b.updated_at - a.updated_at,
  );
  const cards: Array<ReturnType<typeof dueCards>[number] & { planId: string; planTitle: string }> =
    [];
  for (const row of ordered) {
    if (cards.length >= 20) break;
    for (const card of dueCards(db, row.id, now))
      cards.push({ ...card, planId: row.id, planTitle: row.title });
  }
  return cards.slice(0, 20);
}
