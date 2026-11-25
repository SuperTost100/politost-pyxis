import type Database from "better-sqlite3";
import { z } from "zod";
import { foldText } from "../../shared/fold-text";
import { nextExamDate, SESSION_DATE_MAX } from "../../shared/exam-sessions";
import type { PathProposalView } from "../../shared/ipc";
import { dayKey, startOfDay } from "../../shared/local-day";
import { readPlannerSettings, savePlannerHours } from "../plans/planner";
import { readSessions } from "../plans/sessions";
import { savePlanSettings } from "../plans/settings";
import { editPlanTopics, PATH_TOPICS_MAX, TOPIC_TITLE_MAX } from "../plans/topicsEdit";
import { queueSyllabusChecks } from "../sources/syllabus";
import { toolRunner } from "./jobs";
import { plainName, propose, ProposalStale, registerProposalKind, type ProposalContext, type ProposalKind } from "./proposals";
import { quizTopic } from "./quiz";
import type { Tool, ToolTurn } from "./server";

/**
 * `propose_path_change`: the model proposes a change to the path of the chat's exam, and the student applies it or not
 * (`proposals.ts`). What the app's own screens let a student change is what it offers: the exam's date (the exam's
 * settings), the weekly study hours (the planner, which holds them for every exam, so the card says so), and the path's
 * topics, removed, added or moved by hand (`editPlanTopics`, which archives and never deletes, as a rebuild does).
 */

export const PATH_TOOL = "propose_path_change";

const line = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((text) => text.replace(/\s+/g, " ").trim().slice(0, max))
    .pipe(z.string().min(1));

const place = {
  after: line(TOPIC_TITLE_MAX)
    .optional()
    .describe("The title of the topic it goes right after, as the path or this call names it."),
  first: z.boolean().optional().describe("True to put it first in the path."),
};

export const pathInput = z
  .object({
    exam_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The exam's new date as YYYY-MM-DD, only when the student gave a new date."),
    weekly_hours: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("The student's new study hours a week, only when they asked to change them. They hold for all their exams."),
    remove_topics: z.array(line(TOPIC_TITLE_MAX)).max(20).optional().describe("Titles of topics to take out of the path."),
    add_topics: z
      .array(z.object({ title: line(TOPIC_TITLE_MAX).describe("The new topic's title."), ...place }).strict())
      .max(10)
      .optional()
      .describe("New topics; without `after` or `first` a topic goes at the end."),
    move_topics: z
      .array(z.object({ title: line(TOPIC_TITLE_MAX).describe("The title of a topic in the path."), ...place }).strict())
      .max(20)
      .optional()
      .describe("Topics to move: each needs `after` or `first`."),
  })
  .strict();

export const PATH_DESCRIPTION = [
  "Proposes a change to the path of this chat's exam in Pyxis: the exam's date, the topics of the path (remove, add, move), or the student's weekly study hours. It changes nothing by itself: the student sees the change as a card in your answer, with the old and new values, and applies it or not.",
  "Call it when the student asks to change their exam's date, the topics of their path or their study hours, or accepts your offer to. Never call it on your own initiative.",
  "Give only what the student asked to change. Name topics by their title in the path. Removing a topic archives it: its lessons, flashcards and grades stay, and come back if it is added again.",
  "The weekly hours are the student's for all their exams, not for this one only.",
  "If a title does not match the path, the result lists the path's topics: then call again with titles from that list, or ask the student.",
  "One proposal of this kind per answer. After the call, say in one short sentence what you prepared and that nothing changes until the student presses Apply on the card. Never say the change is made: you will be told what the student chose in their next message.",
].join(" ");

type TopicAfter = { id: string | null; title: string; added: boolean; restored: boolean; movedFrom: number | null };

/** What a path request resolves to: the exact change, with everything its card shows. */
export type PathProposal = {
  planId: string;
  exam: string;
  date: {
    sessionId: string | null;
    from: number | null;
    to: number;
    label: string | null;
    /** The exam's sessions as they are, so any change to one makes the card stale. */
    sessions: unknown[];
    /** The next session once this one moves, when it is another one. */
    next: { date: number; label: string | null } | null;
  } | null;
  hours: { from: number | null; to: number } | null;
  topics: { before: Array<{ id: string; title: string }>; after: TopicAfter[] } | null;
  /** What the request asked that is already so, for the model. */
  already: string[];
};

export type PathRequest = z.infer<typeof pathInput>;

type PathOutcome = { date: number | null; hours: number | null; changed: number };

type Exam = { id: string; title: string; target: number };

/** The chat's exam: its own, or its subject's when the subject has exactly one that is not archived. */
export function chatExam(
  db: Database.Database,
  where: ReturnType<ToolTurn["place"]>,
): Exam | { refused: string } {
  const live = "archived_at IS NULL AND status != 'building'";
  // A chat of an exam acts on that exam or on none: never on another exam of its subject.
  if (where.planId) {
    const plan = db.prepare(`SELECT id, title, target, ${live} AS live FROM plans WHERE id = ?`).get(where.planId) as
      | (Exam & { live: number })
      | undefined;
    if (plan?.live) return { id: plan.id, title: plan.title, target: plan.target };
    if (plan)
      return {
        refused: `This chat's exam, ${plan.title}, is archived or still being built, so nothing was proposed. Tell the student in one sentence: they can bring it back from Esami, or wait until it is ready.`,
      };
  }
  const exams = where.subject
    ? (db
        .prepare(
          `SELECT id, title, target FROM plans WHERE ${live}
             AND subject_id = (SELECT id FROM subjects WHERE name = ? COLLATE NOCASE)`,
        )
        .all(where.subject.trim()) as Exam[])
    : [];
  if (exams.length === 1) return exams[0]!;
  return {
    refused:
      exams.length > 1
        ? `This chat's subject has ${exams.length} exams (${exams.map((exam) => exam.title).join(", ")}), and a proposal applies to one. Nothing was proposed. Ask the student to open a chat from the exam they mean.`
        : "This chat has no exam in Pyxis, so nothing was proposed. Tell the student in one sentence.",
  };
}

const activeTopics = (db: Database.Database, planId: string) =>
  db.prepare("SELECT id, title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position, id").all(planId) as Array<{
    id: string;
    title: string;
  }>;

const folded = (title: string) => foldText(title).replace(/\s+/g, " ").trim();

/** A YYYY-MM-DD day as local noon, as sessions store a day; null for a day that does not exist. */
function noonOf(text: string): number | null {
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
}

/** The session a new date moves: the next one, as the exam page counts down to it. Null for an exam with no date. */
function nextSession(db: Database.Database, planId: string, now: number) {
  const sessions = readSessions(db, planId);
  const next = nextExamDate(sessions.map((session) => session.date), now);
  return next === null ? null : (sessions.find((session) => session.date === next) ?? null);
}

function planTopics(
  db: Database.Database,
  planId: string,
  args: z.infer<typeof pathInput>,
): { before: Array<{ id: string; title: string }>; after: TopicAfter[] } | { refused: string } | null {
  if (!args.remove_topics?.length && !args.add_topics?.length && !args.move_topics?.length) return null;
  const before = activeTopics(db, planId);
  const list = (): string => before.map((topic, i) => `${i + 1}. ${topic.title}`).join("; ");
  const unknown = (title: string) => ({
    refused: `No topic of the path matches "${title}", so nothing was proposed. The path's topics are: ${list()}. Call again with titles from this list, or ask the student which one they mean.`,
  });
  const work: TopicAfter[] = before.map((topic) => ({ id: topic.id, title: topic.title, added: false, restored: false, movedFrom: null }));
  const existing = (title: string) => quizTopic(db, planId, title);
  /** Where a topic goes: after the one `after` names (in the list as it is now), first, or at the end. */
  const slot = (where: { after?: string; first?: boolean }): number | { refused: string } => {
    if (where.first) return 0;
    if (!where.after) return work.length;
    const byTitle = work.findIndex((topic) => folded(topic.title) === folded(where.after!));
    if (byTitle >= 0) return byTitle + 1;
    const match = existing(where.after);
    const index = match ? work.findIndex((topic) => topic.id === match.id) : -1;
    return index >= 0 ? index + 1 : unknown(where.after);
  };
  for (const title of args.remove_topics ?? []) {
    const match = existing(title);
    const index = match ? work.findIndex((topic) => topic.id === match.id) : -1;
    if (index < 0) return unknown(title);
    work.splice(index, 1);
  }
  const archived = db
    .prepare("SELECT id, title FROM topics WHERE plan_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC")
    .all(planId) as Array<{ id: string; title: string }>;
  for (const move of args.move_topics ?? []) {
    if (!move.after && !move.first)
      return { refused: `Moving "${move.title}" needs \`after\` (a topic's title) or \`first\`. Nothing was proposed.` };
    const match = existing(move.title);
    if (!match || !work.some((topic) => topic.id === match.id)) return unknown(move.title);
  }
  for (const add of args.add_topics ?? [])
    if (work.some((topic) => folded(topic.title) === folded(add.title)) || before.some((topic) => folded(topic.title) === folded(add.title)))
      return { refused: `The path already has a topic called "${add.title}", so nothing was proposed. To move it, use move_topics.` };
  // Moves, then additions, each placed once the topic it goes after is in the list: a move may name a topic the same
  // call adds, and an addition one it moves.
  type Step = { move: true; title: string; after?: string; first?: boolean } | { move: false; title: string; after?: string; first?: boolean };
  let waiting: Step[] = [
    ...(args.move_topics ?? []).map((move) => ({ ...move, move: true as const })),
    ...(args.add_topics ?? []).map((add) => ({ ...add, move: false as const })),
  ];
  const placed = (step: Step) => {
    if (step.first || !step.after) return true;
    const after = step.after;
    if (work.some((topic) => folded(topic.title) === folded(after))) return true;
    const match = existing(after);
    return !!match && match.id !== (step.move ? existing(step.title)?.id : undefined) && work.some((topic) => topic.id === match.id);
  };
  while (waiting.length) {
    const ready = waiting.find(placed);
    if (!ready) return unknown(waiting[0]!.after ?? waiting[0]!.title);
    waiting = waiting.filter((step) => step !== ready);
    if (ready.move) {
      const id = existing(ready.title)!.id;
      const [moving] = work.splice(work.findIndex((topic) => topic.id === id), 1);
      const at = slot(ready);
      if (typeof at !== "number") return at;
      work.splice(at, 0, { ...moving!, movedFrom: before.findIndex((topic) => topic.id === moving!.id) + 1 });
    } else {
      const at = slot(ready);
      if (typeof at !== "number") return at;
      const back = archived.find((topic) => folded(topic.title) === folded(ready.title));
      work.splice(at, 0, { id: back?.id ?? null, title: back?.title ?? ready.title, added: true, restored: !!back, movedFrom: null });
    }
  }
  if (work.length === 0) return { refused: "That would leave the path with no topics, so nothing was proposed. Tell the student a path needs at least one topic." };
  if (work.length > PATH_TOPICS_MAX) return { refused: `A path holds at most ${PATH_TOPICS_MAX} topics, so nothing was proposed.` };
  // A move that lands where the topic already was changes nothing, and is not shown as one.
  for (const [index, topic] of work.entries()) if (topic.movedFrom !== null && before[index]?.id === topic.id) topic.movedFrom = null;
  const same = work.length === before.length && work.every((topic, i) => topic.id === before[i]!.id);
  return same ? null : { before, after: work };
}

const changedTopics = (topics: PathProposal["topics"]) =>
  topics
    ? topics.before.filter((topic) => !topics.after.some((next) => next.id === topic.id)).length +
      topics.after.filter((topic) => topic.added || topic.movedFrom !== null).length
    : 0;

function summary(proposal: PathProposal): string {
  const parts: string[] = [];
  if (proposal.date)
    parts.push(
      `exam date from ${proposal.date.from === null ? "none" : dayKey(proposal.date.from)} to ${dayKey(proposal.date.to)}${proposal.date.next ? ` (the next session would then be another one, on ${dayKey(proposal.date.next.date)})` : ""}`,
    );
  if (proposal.hours) parts.push(`weekly study hours, for all exams, from ${proposal.hours.from ?? "not set"} to ${proposal.hours.to}`);
  if (proposal.topics) {
    const removed = proposal.topics.before.filter((topic) => !proposal.topics!.after.some((next) => next.id === topic.id));
    const added = proposal.topics.after.filter((topic) => topic.added);
    const moved = proposal.topics.after.filter((topic) => topic.movedFrom !== null);
    if (removed.length) parts.push(`remove ${removed.map((topic) => `"${topic.title}"`).join(", ")}`);
    if (added.length) parts.push(`add ${added.map((topic) => `"${topic.title}"`).join(", ")}`);
    if (moved.length) parts.push(`move ${moved.map((topic) => `"${topic.title}"`).join(", ")}`);
    parts.push(`topics after: ${proposal.topics.after.map((topic) => topic.title).join(", ")}`);
  }
  return `a change to the path of ${proposal.exam}: ${parts.join("; ")}`;
}

/** What the proposal did once applied, as the model reads it. */
export function pathNote(view: PathProposalView): string {
  const what = `a change to the path of ${view.exam}`;
  if (view.state === "applied") return `[Pyxis tool ${PATH_TOOL}: you proposed ${what}; the student applied it, and the path is now as proposed.]`;
  if (view.state === "declined") return `[Pyxis tool ${PATH_TOOL}: you proposed ${what}; the student chose not to apply it, so nothing changed.]`;
  if (view.state === "stale") return `[Pyxis tool ${PATH_TOOL}: you proposed ${what}; the path changed before the student decided, so it can no longer be applied and nothing changed.]`;
  if (view.state === "expired") return `[Pyxis tool ${PATH_TOOL}: you proposed ${what}; a later proposal replaced it, so nothing changed through it.]`;
  return `[Pyxis tool ${PATH_TOOL}: you proposed ${what}; it is shown to the student, who has not decided yet, and nothing has changed.]`;
}

/** What a path request means now, in the chat's place: the change it would make, or why there is none. */
function resolve(db: Database.Database, args: PathRequest, ctx: Omit<ProposalContext, "resultId">): PathProposal | { refused: string } {
  const exam = chatExam(db, ctx.place);
  if ("refused" in exam) return exam;
  const already: string[] = [];
  let date: PathProposal["date"] = null;
  if (args.exam_date) {
    const to = noonOf(args.exam_date);
    if (to === null || to > SESSION_DATE_MAX)
      return { refused: `${args.exam_date} is not a valid date, so nothing was proposed. Give the date as YYYY-MM-DD.` };
    if (to < startOfDay(ctx.now)) return { refused: `${args.exam_date} is already past, so nothing was proposed. Ask the student for the new date.` };
    const sessions = readSessions(db, exam.id);
    const session = nextSession(db, exam.id, ctx.now);
    if (session?.date === to) already.push(`the exam is already on ${args.exam_date}`);
    else {
      const after = session ? sessions.map((entry) => (entry.id === session.id ? { ...entry, date: to } : entry)) : [...sessions, { id: "", date: to, label: null }];
      const nextDate = nextExamDate(after.map((entry) => entry.date), ctx.now);
      const nextEntry = after.find((entry) => entry.date === nextDate);
      date = {
        sessionId: session?.id ?? null,
        from: session?.date ?? null,
        to,
        label: session?.label ?? null,
        sessions,
        next: nextDate !== null && nextDate !== to ? { date: nextDate, label: nextEntry?.label ?? null } : null,
      };
    }
  }
  let hours: PathProposal["hours"] = null;
  if (args.weekly_hours !== undefined) {
    const to = Math.round(args.weekly_hours * 2) / 2;
    const from = readPlannerSettings(db).weeklyHours;
    if (from !== to) hours = { from, to };
    else already.push(`the weekly hours are already ${args.weekly_hours}`);
  }
  const topics = planTopics(db, exam.id, args);
  if (topics && "refused" in topics) return topics;
  if (!date && !hours && !topics)
    return { refused: "That is already how the path is (or the call named no change), so nothing was proposed. Tell the student in one sentence." };
  return { planId: exam.id, exam: plainName(exam.title), date, hours, topics, already };
}

const kind: ProposalKind<PathRequest, PathProposal> = {
  tool: PATH_TOOL,
  resolve,
  apply(db, action) {
    const plan = db.prepare("SELECT title, target, status, archived_at AS archivedAt FROM plans WHERE id = ?").get(action.planId) as
      | { title: string; target: number; status: string; archivedAt: number | null }
      | undefined;
    if (!plan || plan.status === "building" || plan.archivedAt !== null) throw new ProposalStale();
    if (action.date) {
      const sessions = readSessions(db, action.planId);
      const moved = action.date.sessionId ? sessions.find((session) => session.id === action.date!.sessionId) : undefined;
      if (action.date.sessionId && !moved) throw new ProposalStale();
      const next = moved
        ? sessions.map((session) => (session.id === moved.id ? { ...session, date: action.date!.to } : session))
        : [...sessions, { date: action.date.to, time: null, place: null, label: null }];
      savePlanSettings(db, { planId: action.planId, title: plan.title, target: plan.target, sessions: next });
    }
    if (action.topics)
      editPlanTopics(
        db,
        action.planId,
        action.topics.after.map((topic) =>
          topic.restored && topic.id ? { restore: topic.id } : topic.id && !topic.added ? { id: topic.id } : { title: topic.title },
        ),
      );
    if (action.hours) savePlannerHours(db, { hours: action.hours.to });
    // What a plan edit changes is what the stored source comparison depends on, as after the exam's own settings.
    try {
      queueSyllabusChecks(db, toolRunner(), action.planId);
    } catch (err) {
      if (!(err instanceof Error && err.message === "tool-runner-missing")) throw err;
    }
    return {
      // The exam's next session after the change, which is what the exam page counts down to.
      date: action.date ? (action.date.next?.date ?? action.date.to) : null,
      hours: action.hours?.to ?? null,
      changed: changedTopics(action.topics),
    } satisfies PathOutcome;
  },
  view(db, base, action, decision): PathProposalView {
    const gone = !db.prepare("SELECT 1 FROM plans WHERE id = ?").get(action.planId);
    const after = action.topics?.after ?? [];
    const outcome = decision?.state === "applied" ? (decision.outcome as PathOutcome) : null;
    return {
      ...base,
      tool: PATH_TOOL,
      planId: action.planId,
      exam: action.exam,
      gone,
      date: action.date ? { from: action.date.from, to: action.date.to, label: action.date.label, next: action.date.next } : null,
      datePast: action.date !== null && action.date.to < startOfDay(Date.now()),
      hours: action.hours
        ? { ...action.hours, exams: db.prepare("SELECT count(*) FROM plans WHERE archived_at IS NULL").pluck().get() as number }
        : null,
      before: (action.topics?.before ?? []).map((topic) => ({ title: plainName(topic.title), removed: !after.some((next) => next.id === topic.id) })),
      after: after.map(({ title, added, restored, movedFrom }) => ({ title: plainName(title), added, restored, movedFrom })),
      changed: changedTopics(action.topics),
      appliedDate: outcome?.date ?? null,
    };
  },
};
registerProposalKind(kind);

export function proposePathTool(db: Database.Database): Tool {
  return {
    name: PATH_TOOL,
    description: PATH_DESCRIPTION,
    input: pathInput,
    run(turn, raw) {
      if ((turn.tally[PATH_TOOL] ?? 0) >= 1)
        return {
          isError: true,
          text: "This answer already proposed a change to the path, and one answer may propose one. Nothing more was proposed: put everything in one call next time.",
        };
      const made = propose<PathRequest, PathProposal>(db, turn, PATH_TOOL, raw as PathRequest);
      if ("refused" in made) return { isError: true, text: made.refused };
      turn.tally[PATH_TOOL] = 1;
      const { action } = made;
      return {
        text: `Shown to the student as a card to confirm: ${summary(action)}.${action.already.length ? ` Left out because ${action.already.join(" and ")}.` : ""} They have not decided yet and nothing has changed. In one short sentence say what you prepared and that nothing changes until they apply it; do not list the changes again and never say they are done.`,
        shown: { resultId: made.resultId },
      };
    },
  };
}
