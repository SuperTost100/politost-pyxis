import type Database from "better-sqlite3";
import { z } from "zod";
import { pathNext, stayActivities, type Activity, type Step, type TopicStatus } from "./path";
import { pathState } from "./create";
import { countDeckDue, countDueCards, deckDueCards, dueCards, examlessDecks, NO_TOPIC } from "../study/cards";
import { planMasteryBreakdown, topicPassageCounts, weightedPlanMastery } from "./progress";
import { putSetting } from "../settings";
import { addDays, dayKey, startOfDay, startOfWeek } from "../../shared/local-day";
import { outlineProgress, partsDoneSince } from "../study/partProgress";

/**
 * The session planner and Oggi. See "Session planner" in docs/mastery.md: remaining work is an estimate in minutes from
 * what the path knows (unread lessons, topics below the target, a simulation not yet done), and each exam's work is
 * spread evenly over the days before it, within the hours the student has. Everything is computed again from the
 * current state on every read, so a missed day re-plans the rest.
 */

/** Minutes one step of each kind takes, for the estimate. Cards are review, outside the planned work. */
const stepMinutes: Record<Activity, number> = {
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
const studyPlans = `SELECT id, title, exam_at, target, updated_at, subject_id,
  (SELECT name FROM subjects s WHERE s.id = p.subject_id) AS subject
  FROM plans p WHERE status <> 'building' AND archived_at IS NULL`;

type PlanRow = {
  id: string;
  title: string;
  exam_at: number | null;
  target: number;
  updated_at: number;
  subject_id: string | null;
  subject: string | null;
};

const plannerKey = "planner";

const plannerSettings = z.object({
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
  const thisWeek = dayKey(startOfWeek(now));
  next.weeks = Object.fromEntries(Object.entries(next.weeks).filter(([week]) => week >= thisWeek));
  putSetting(db, plannerKey, plannerSettings.parse(next), now);
  return { ok: true };
}


/** One piece of a plan's remaining work: the start (introduction and diagnostic), a topic, or the simulation. */
export type WorkPiece = { kind: "start" | "topic" | "simulation"; topicId: string | null; minutes: number };

/**
 * The work a plan has left, from the path's view of it, in the path's order: the introduction and diagnostic while
 * nothing was studied, then each topic below the target in the plan's order (its lesson if unread, and its graded
 * activities), then one simulation until one is done. An unread lesson in parts counts the minutes of its parts not
 * done, any other unread lesson `stepMinutes.lesson`. A topic at zero mastery needs `stayActivities` (3) graded
 * activities; one part of the way there needs that share of them, rounded up.
 */
export function remainingWork(input: {
  topics: Array<Pick<TopicStatus, "id" | "mastery" | "partMinutes">>;
  steps: Array<Pick<Step, "activity" | "topicId">>;
  hasIntro: boolean;
  target: number;
}): WorkPiece[] {
  const done = (activity: Activity) => input.steps.some((step) => step.activity === activity);
  const read = new Set(
    input.steps.filter((step) => step.activity === "lesson").map((step) => step.topicId),
  );
  const studied =
    input.steps.some((step) => step.activity !== "intro" && step.activity !== "diagnostic") ||
    input.topics.some((topic) => topic.mastery > 0);
  const pieces: WorkPiece[] = [];
  if (!studied && !done("diagnostic") && input.topics.length)
    pieces.push({
      kind: "start",
      topicId: null,
      minutes:
        stepMinutes.diagnostic + (input.hasIntro && !done("intro") ? stepMinutes.intro : 0),
    });
  for (const topic of input.topics) {
    if (topic.mastery >= input.target) continue;
    const share = (input.target - topic.mastery) / input.target;
    pieces.push({
      kind: "topic",
      topicId: topic.id,
      minutes:
        (read.has(topic.id) ? 0 : (topic.partMinutes?.left ?? stepMinutes.lesson)) +
        Math.ceil(stayActivities * share - 1e-9) * stepMinutes.quiz,
    });
  }
  if (input.topics.length && !done("simulation"))
    pieces.push({ kind: "simulation", topicId: null, minutes: stepMinutes.simulation });
  return pieces;
}

/** The minutes of work a plan has left: the sum of `remainingWork`. */
export function remainingMinutes(input: Parameters<typeof remainingWork>[0]): number {
  return remainingWork(input).reduce((sum, piece) => sum + piece.minutes, 0);
}

/**
 * The day each piece of work ends at the planner's pace, as an offset from today. The pieces are done in order with
 * the minutes the planner gives the plan each day (`given`, from today); `offset` is the work already done today,
 * which the day's minutes cover first because the planner lays a plan out from the start of today. A piece ends on the
 * first day whose minutes so far cover it and every piece before it, within the 2.5 minutes Oggi allows; null when the
 * days before the exam do not.
 */
export function finishDays(pieces: number[], offset: number, given: number[]): Array<number | null> {
  let work = offset;
  return pieces.map((minutes) => {
    work += minutes;
    let covered = 0;
    for (let day = 0; day < given.length; day += 1) {
      covered += given[day]!;
      if (covered >= work - 2.5) return day;
    }
    return null;
  });
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
 * Today's goal split among the exams still to study, in proportion to the pace each needs (its work left over the days
 * before it, the same pace `spread` uses to share a short day). The shares add up to `goal`; an exam with no work left
 * takes none. One exam gets all of it.
 */
export function todayGoals(exams: SpreadExam[], goal: number): Map<string, number> {
  const need = exams
    .filter((exam) => exam.examDay > 0 && exam.remaining > 0)
    .map((exam) => [exam.id, exam.remaining / exam.examDay] as const);
  const total = need.reduce((sum, [, pace]) => sum + pace, 0);
  return new Map(need.map(([id, pace]) => [id, (goal * pace) / total]));
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
  const rows = db.prepare(`${studyPlans} ORDER BY updated_at DESC`).all() as PlanRow[];
  return rows.flatMap((row) => studiedPlan(db, row, now) ?? []);
}

/** One plan as the planner reads it, or null while it is building. */
function studiedPlan(db: Database.Database, row: PlanRow, now: number) {
  const today = startOfDay(now);
  // Today counts due cards per plan as one item, so the path's per-topic counts are not needed here.
  const state = pathState(db, row.id, now, { dueCards: false });
  if (!state) return null;
  const doneToday = state.steps.filter((step) => step.at >= today && step.activity !== "cards");
  const partsToday = partsDoneSince(db, row.id, today);
  const outlines = outlineProgress(db, row.id);
  const remainingNow = remainingMinutes(state);
  // A lesson in parts counts each part's minutes when it is done, so the step its last part records adds none. A
  // lesson step recorded before its topic had parts was a lesson read whole, and keeps its minutes.
  const minutesOf = (step: Step) =>
    step.activity === "lesson" && step.topicId && (outlines.get(step.topicId)?.createdAt ?? Infinity) <= step.at
      ? 0
      : stepMinutes[step.activity];
  const doneMinutes =
    doneToday.reduce((sum, step) => sum + minutesOf(step), 0) +
    partsToday.reduce((sum, part) => sum + part.minutes, 0);
  // The mastery the exam list shows, weighted by passages.
  const mastery = weightedPlanMastery(state.topics, topicPassageCounts(db, row.id));
  return {
    row,
    state,
    doneToday,
    /** Steps or parts done today: Oggi measures the day only once something was studied. */
    studiedToday: doneToday.length + partsToday.length > 0,
    doneMinutes,
    // The plan is laid out from the start of today, so studying today does not move today's share.
    remaining: remainingNow + doneMinutes,
    remainingNow,
    mastery,
  };
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
    ? spread(exams, (day) => ((weekHours(startOfWeek(addDays(today, day))) ?? 0) * 60) / 7)
    : null;
  // Oggi measures the student's goal, a seventh of this week's hours, not the pace the planner needs.
  const goals = planned ? todayGoals(exams, ((weekHours(startOfWeek(today)) ?? 0) * 60) / 7) : null;
  return { settings, dated, exams, weekHours, result, goals, today };
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
    for (let start = startOfWeek(today); start <= addDays(today, last); start = addDays(start, 7)) {
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

/**
 * When an exam's topics and simulation should be done at the session planner's pace: its remaining work in the path's
 * order, laid on the minutes the planner gives the exam each day before it (`finishDays`). Null when the planner has no
 * days for the exam: no hours set, no date, the exam is today or past, or the exam is archived. A topic already at the
 * target has no entry; an entry with a null date does not fit before the exam at this pace.
 */
export function planSchedule(db: Database.Database, planId: string, now = Date.now()) {
  const plans = studyState(db, now);
  const { exams, result, today } = layout(db, plans, now);
  const plan = plans.find((item) => item.row.id === planId);
  const exam = exams.find((item) => item.id === planId);
  if (!plan || !exam || !result) return null;
  const pieces = remainingWork(plan.state);
  const given = Array.from({ length: exam.examDay }, (_, day) => result.days[day]?.get(planId) ?? 0);
  const ends = finishDays(
    pieces.map((piece) => piece.minutes),
    plan.doneMinutes,
    given,
  );
  const date = (index: number) => {
    const end = ends[index];
    return end == null ? null : dayKey(addDays(today, end));
  };
  const simulation = pieces.findIndex((piece) => piece.kind === "simulation");
  return {
    topics: pieces.flatMap((piece, index) =>
      piece.kind === "topic" && piece.topicId ? [{ topicId: piece.topicId, date: date(index) }] : [],
    ),
    simulation: simulation < 0 ? null : { date: date(simulation) },
    behind: examView(plan, exams, result, today).behind,
  };
}

/** Oggi lists due flashcards as one item, then one item per plan; this is the plan item's next step. */
function nextStep(state: PlanState) {
  return pathNext({
    topics: state.topics,
    steps: state.steps,
    hasIntro: state.hasIntro,
    target: state.target,
    daysToExam: state.daysToExam,
  });
}

/**
 * The minutes Oggi asks of a plan today: its share of the student's goal for the day (see `todayGoals`). Null when
 * nothing measures the day (no hours set, no date, or the exam is today).
 */
function todayMinutes(plan: Studied, goals: Map<string, number> | null): number | null {
  const days = plan.state.daysToExam;
  return goals != null && days != null && days > 0 ? (goals.get(plan.row.id) ?? 0) : null;
}

/**
 * Oggi ticks a plan off once today's steps cover its minutes for the day, within 2.5 minutes, and at least one
 * step was done. Without minutes (no weekly hours, no date, the exam day) nothing measures the day, so it never ticks off:
 * one step alone never makes the day's work.
 */
function todayComplete(
  plan: Pick<Studied, "studiedToday" | "doneMinutes">,
  minutes: number | null,
): boolean {
  return minutes != null && plan.studiedToday && plan.doneMinutes >= minutes - 2.5;
}

/**
 * Today's study across every exam: due flashcards from all plans as one item, then each plan's next step, the closest
 * exam first and plans without a date after the dated ones. With hours set in the planner, a plan's item is done once
 * today's steps cover its part of the student's goal for the day (at least one step), and a plan whose part is under
 * 2.5 minutes today is left out unless it was studied today. Without hours, or without minutes for the plan today, an
 * item is never done: nothing measures the day. Exams already past are left out.
 */
export function todayPlan(db: Database.Database, now = Date.now()) {
  const plans = studyState(db, now);
  const { dated, exams, result, goals, today } = layout(db, plans, now);
  const dueByPlan = plans.map((plan) => countDueCards(db, plan.row.id, now));
  // Flashcards with no exam are due in the same daily review.
  const examless = examlessDecks(db).reduce(
    (sum, deck) => sum + countDeckDue(db, { subjectId: deck.subjectId }, now),
    0,
  );
  const due = dueByPlan.reduce((sum, count) => sum + count, examless);
  const rated = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM card_reviews r JOIN cards c ON c.id = r.card_id
         WHERE r.reviewed_at >= ? AND (c.plan_id IS NULL OR c.plan_id IN (SELECT id FROM (${studyPlans})))`,
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
      const minutes = todayMinutes(plan, goals);
      // An allocation under the 2.5 minute tolerance is too small to ask for and would tick off with no work done.
      if (minutes != null && minutes < 2.5 && !plan.studiedToday) return [];
      if (!next && !plan.studiedToday) return [];
      const complete = todayComplete(plan, minutes);
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
 * Due flashcards from every plan for Oggi's one cards item: the closest exam's cards first, then plans without a date
 * and each subject's cards with no exam, past exams last; at most 20 at a time, like a plan's own session.
 *
 * `only` narrows it to one subject (`subjectId: null` for the cards with no subject), and with `examless` to that
 * subject's cards with no exam: the Flashcard section's review of a subject. With `planId` it is one exam's due cards,
 * the ones its page counts, and with `noTopic` that exam's cards with no topic.
 */
export function dueEverywhere(
  db: Database.Database,
  now = Date.now(),
  only?: { subjectId: string | null; examless?: boolean } | { planId: string; noTopic?: boolean },
) {
  const today = startOfDay(now);
  const topicId = only && "planId" in only && only.noTopic ? NO_TOPIC : undefined;
  const rows = (db.prepare(studyPlans).all() as PlanRow[]).filter((row) =>
    !only ? true : "planId" in only ? row.id === only.planId : !only.examless && row.subject_id === only.subjectId,
  );
  const rank = (row: PlanRow) =>
    row.exam_at == null ? 1 : startOfDay(row.exam_at) < today ? 2 : 0;
  const ordered = rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.exam_at ?? 0) - (b.exam_at ?? 0) ||
      b.updated_at - a.updated_at,
  );
  type Due = ReturnType<typeof dueCards>[number] & {
    planId: string | null;
    planTitle: string | null;
    subject: string | null;
  };
  const decks: Array<() => Due[]> = [
    ...ordered
      .filter((row) => rank(row) < 2)
      .map((row) => () =>
        dueCards(db, row.id, now, topicId).map((card) => ({ ...card, planId: row.id, planTitle: row.title, subject: row.subject })),
      ),
    ...examlessDecks(db)
      .filter((deck) => !only || ("subjectId" in only && deck.subjectId === only.subjectId))
      .map((deck) => () =>
        deckDueCards(db, { subjectId: deck.subjectId }, now).map((card) => ({
          ...card,
          planId: null,
          planTitle: null,
          subject: deck.subject,
        })),
      ),
    ...ordered
      .filter((row) => rank(row) === 2)
      .map((row) => () =>
        dueCards(db, row.id, now, topicId).map((card) => ({ ...card, planId: row.id, planTitle: row.title, subject: row.subject })),
      ),
  ];
  const cards: Due[] = [];
  for (const deck of decks) {
    if (cards.length >= 20) break;
    cards.push(...deck());
  }
  return cards.slice(0, 20);
}

/** Flashcards due with no exam, across subjects: the ones the daily review adds to the exams' own, as Oggi counts them. */
export function examlessDue(db: Database.Database, now = Date.now()) {
  return examlessDecks(db).reduce(
    (sum, deck) => sum + countDeckDue(db, { subjectId: deck.subjectId }, now),
    0,
  );
}

/** Activities that measure the student; a plan with none of them and no mastery has nothing measured yet. */
const measuring = (activity: Activity) => activity !== "intro" && activity !== "lesson";

/**
 * The three rings of each built exam, from what the planner and Oggi already compute:
 *
 * - `preparation`: the mastery the exam list shows (topics weighted by passages), which the renderer reads on the
 *   student's grade scale. Null while nothing is measured: no topic has mastery or evidence and no graded step was
 *   done.
 * - `path`: the share of the path's work done, in the planner's minutes: one minus the work left (`remainingWork`) over
 *   the work the same path had with nothing studied. Null when the exam has no topics, so no path.
 * - `today`: the share of today's goal done, as Oggi counts it: the minutes of today's steps over the exam's part of
 *   the student's goal for the day (`todayGoals`: a seventh of the week's hours, split among the exams in proportion
 *   to what each needs), and `todayMinutes` those two numbers in minutes. Null when nothing measures it, and
 *   `todayUnmeasured` says why: no weekly hours set (`no-goal`, the student is offered to set them), no exam date
 *   (`no-date`) or the exam is today (`exam-day`). Also null, with no reason, when nothing is planned today: an archived
 *   or past exam, a share too small to ask for, or no next step, unless something was done today anyway.
 *
 * `next` is the path's next step without due cards (Oggi lists those apart), and `dueCards` this exam's due cards.
 * Archived exams come after the others, with no Oggi.
 */
export function examRings(db: Database.Database, now = Date.now()) {
  const active = studyState(db, now);
  const { result, goals } = layout(db, active, now);
  const archived = (
    db
      .prepare(
        `SELECT id, title, exam_at, target, updated_at, NULL AS subject FROM plans
         WHERE status <> 'building' AND archived_at IS NOT NULL ORDER BY updated_at DESC`,
      )
      .all() as PlanRow[]
  ).flatMap((row) => studiedPlan(db, row, now) ?? []);
  const titles = db.prepare("SELECT title FROM topics WHERE id = ?");
  const ring = (plan: Studied, isArchived: boolean) => {
    const { state } = plan;
    // Measured means there is evidence, whatever its score: a wrong quick-check answer is evidence worth zero.
    const measured =
      state.topics.some((topic) => topic.mastery > 0) ||
      state.steps.some((step) => measuring(step.activity)) ||
      planMasteryBreakdown(db, plan.row.id, now).some((topic) =>
        Object.values(topic.parts).some((part) => part.count > 0),
      );
    // A lesson in parts starts with all its parts' minutes left.
    const fresh = remainingMinutes({
      topics: state.topics.map((topic) => ({
        id: topic.id,
        mastery: 0,
        ...(topic.partMinutes ? { partMinutes: { total: topic.partMinutes.total, left: topic.partMinutes.total } } : {}),
      })),
      steps: [],
      hasIntro: state.hasIntro,
      target: state.target,
    });
    const next = nextStep(state);
    const minutes = isArchived ? null : todayMinutes(plan, goals);
    const today = isArchived ? null : todayShare(plan, minutes, next != null);
    return {
      planId: plan.row.id,
      preparation: measured ? plan.mastery : null,
      path: fresh > 0 ? Math.min(1, Math.max(0, 1 - plan.remainingNow / fresh)) : null,
      today,
      todayMinutes: today == null || minutes == null ? null : { done: plan.doneMinutes, target: Math.round(minutes) },
      todayUnmeasured: isArchived ? null : todayUnmeasured(plan, result != null),
      next: next
        ? {
            activity: next.activity,
            topicId: next.topicId,
            topicTitle: next.topicId
              ? ((titles.get(next.topicId) as { title: string } | undefined)?.title ?? null)
              : null,
          }
        : null,
      dueCards: isArchived ? 0 : countDueCards(db, plan.row.id, now),
    };
  };
  return [...active.map((plan) => ring(plan, false)), ...archived.map((plan) => ring(plan, true))];
}

/** Oggi's share for one exam, with the same rules as Oggi's item: see `examRings`. */
export function todayShare(
  plan: Pick<Studied, "studiedToday" | "doneMinutes"> & { state: Pick<PlanState, "daysToExam"> },
  minutes: number | null,
  hasNext: boolean,
): number | null {
  const days = plan.state.daysToExam;
  const did = plan.studiedToday;
  // Without minutes from the planner nothing measures the day: see `todayUnmeasured`.
  if (minutes == null || (days != null && days < 0)) return null;
  if (!did && (!hasNext || minutes < 2.5)) return null;
  if (todayComplete(plan, minutes)) return 1;
  // Not complete: some minutes short of today's share, or nothing done yet.
  return did ? Math.min(plan.doneMinutes / minutes, 0.99) : 0;
}

/**
 * Why Oggi measures nothing for an exam that is still ahead: no weekly hours (`no-goal`), no date to spread them over
 * (`no-date`), or the exam is today, which gets no study time (`exam-day`). Null when Oggi measures, or the exam is past.
 */
export function todayUnmeasured(
  plan: { state: Pick<PlanState, "daysToExam"> },
  planned: boolean,
): "no-goal" | "no-date" | "exam-day" | null {
  const days = plan.state.daysToExam;
  if (days != null && days < 0) return null;
  if (!planned) return "no-goal";
  if (days == null) return "no-date";
  return days === 0 ? "exam-day" : null;
}
