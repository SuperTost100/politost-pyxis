import type Database from "better-sqlite3";
import { z } from "zod";
import { foldText } from "../../shared/fold-text";
import { SESSION_DATE_MAX } from "../../shared/exam-sessions";
import type { ExamProposalView } from "../../shared/ipc";
import { dayKey, startOfDay } from "../../shared/local-day";
import { PLAN_TITLE_MAX } from "../../shared/plan-file";
import { activityOf } from "../jobs/activity";
import { enqueuePlan } from "../plans/jobs";
import { jobRow, jobState, toolRunner } from "./jobs";
import { plainName, propose, registerProposalKind, type ProposalContext, type ProposalKind } from "./proposals";
import type { Tool } from "./server";

/**
 * `propose_exam`: the model proposes a new exam, and the student creates it or not (`proposals.ts`). The draft has what
 * the app's own exam creation asks for: a name, a subject, the date when the student gave one, and the material. The
 * material is the Library's sources of that subject, chosen by the app, never named by the model. «Crea l'esame» runs
 * the exam creation's own background build (`enqueuePlan`, as `plans.create` does), and the card follows that build.
 * An exam with no material is built by the guided flow, which asks its own questions, so the card then offers only
 * «Modifica prima», which opens the app's form filled in.
 */

export const EXAM_TOOL = "propose_exam";
const SUBJECT_MAX = 80;

const line = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((text) => text.replace(/\s+/g, " ").trim().slice(0, max))
    .pipe(z.string().min(2));

export const examInput = z
  .object({
    title: line(PLAN_TITLE_MAX).describe('The exam\'s name, as the student would call it, such as "Chimica generale".'),
    subject: line(SUBJECT_MAX)
      .optional()
      .describe("The subject it belongs to in Pyxis, when it differs from the name. Without it the name is the subject."),
    exam_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("The exam's date as YYYY-MM-DD, only when the student gave it."),
  })
  .strict();

export const EXAM_DESCRIPTION = [
  "Proposes a new exam in Pyxis, with its own study path. It creates nothing by itself: the student sees the draft as a card in your answer and creates it or not.",
  "Call it when the student asks you to create or set up an exam they have to prepare, or accepts your offer to. Never call it on your own initiative.",
  "Give the exam's name, its subject when it differs, and the date only if the student said it. Pyxis picks the material from the student's Library on that subject; you do not choose it.",
  "One proposal of this kind per answer. After the call, say in one short sentence that you prepared the draft and that nothing exists until the student creates it. Never say the exam is created: you will be told what the student chose in their next message.",
].join(" ");

export type ExamProposal = {
  title: string;
  subject: string | null;
  date: number | null;
  language: "it" | "en";
  sources: Array<{ id: string; title: string }>;
};

type ExamOutcome = { planId: string; jobId: string };

/** The statuses a source cannot be built from, as the exam form refuses them. */
const UNUSABLE = "('failed', 'needs-ocr', 'cancelled', 'interrupted', 'removed')";

/** The Library's sources of a subject, by name, that an exam can be built from. */
function subjectSources(db: Database.Database, subject: string | null): Array<{ id: string; title: string; status: string }> {
  if (!subject) return [];
  return db
    .prepare(
      `SELECT s.id, s.title, s.status FROM sources s JOIN subjects sub ON sub.id = s.subject_id
       WHERE sub.name = ? COLLATE NOCASE AND s.library = 1 AND s.status NOT IN ${UNUSABLE}
       ORDER BY s.title, s.id`,
    )
    .all(subject) as Array<{ id: string; title: string; status: string }>;
}

/** An exam the student has (not archived) whose name is this one's, ignoring case and accents. */
function sameExam(db: Database.Database, title: string): string | null {
  const want = foldText(title).replace(/\s+/g, " ").trim();
  const plans = db.prepare("SELECT id, title FROM plans WHERE archived_at IS NULL ORDER BY created_at DESC").all() as Array<{
    id: string;
    title: string;
  }>;
  return plans.find((plan) => foldText(plan.title).replace(/\s+/g, " ").trim() === want)?.id ?? null;
}

/** A YYYY-MM-DD day as local noon; null for a day that does not exist. */
function noonOf(text: string): number | null {
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
}

export function examNote(view: ExamProposalView): string {
  const what = `a new exam "${view.title}"`;
  if (view.state === "applied")
    return view.created?.gone
      ? `[Pyxis tool ${EXAM_TOOL}: you proposed ${what}; the student created it, and later deleted it.]`
      : `[Pyxis tool ${EXAM_TOOL}: you proposed ${what}; the student created it${view.created?.job === "working" ? ", and Pyxis is building its path" : ""}.]`;
  if (view.state === "declined") return `[Pyxis tool ${EXAM_TOOL}: you proposed ${what}; the student chose not to create it.]`;
  if (view.state === "stale") return `[Pyxis tool ${EXAM_TOOL}: you proposed ${what}; things changed before the student decided (an exam of that name exists now, or the material changed), so it was not created.]`;
  if (view.state === "expired") return `[Pyxis tool ${EXAM_TOOL}: you proposed ${what}; a later proposal replaced it.]`;
  return `[Pyxis tool ${EXAM_TOOL}: you proposed ${what}; it is shown to the student, who has not decided yet, and it does not exist.]`;
}

export type ExamRequest = z.infer<typeof examInput>;

/**
 * What an exam request means now: the exam the form would create, with the Library's usable sources of its subject by
 * id and title, or why there is none (an exam of that name exists, the date is not a day to come).
 */
function resolve(db: Database.Database, args: ExamRequest, ctx: Omit<ProposalContext, "resultId">): ExamProposal | { refused: string } {
  // The name is checked as it would be saved, without the controls a card strips.
  const title = plainName(args.title).replace(/\s+/g, " ").trim();
  if (title.length < 2) return { refused: "The exam needs a name of at least two characters, so nothing was proposed." };
  if (sameExam(db, title))
    return {
      refused: `The student already has an exam called "${args.title}" in Pyxis, so nothing was proposed. Tell them in one sentence; you can offer to change its path instead.`,
    };
  let date: number | null = null;
  if (args.exam_date) {
    date = noonOf(args.exam_date);
    if (date === null || date > SESSION_DATE_MAX)
      return { refused: `${args.exam_date} is not a valid date, so nothing was proposed. Give it as YYYY-MM-DD.` };
    if (date < startOfDay(ctx.now)) return { refused: `${args.exam_date} is already past, so nothing was proposed. Ask the student for the date.` };
  }
  const subject = args.subject ? plainName(args.subject).replace(/\s+/g, " ").trim() || title : title;
  return {
    title,
    subject,
    date,
    language: language(db),
    sources: subjectSources(db, subject).map(({ id, title }) => ({ id, title: plainName(title) })),
  };
}

const kind: ProposalKind<ExamRequest, ExamProposal> = {
  tool: EXAM_TOOL,
  resolve,
  apply(db, proposal) {
    // The exam is created as the exam form sends it, from the material just resolved. A draft without material has no
    // button that applies it.
    if (proposal.sources.length === 0) throw new Error("exam-no-material");
    const created = enqueuePlan(db, toolRunner(), {
      title: proposal.title,
      ...(proposal.subject ? { subject: proposal.subject } : {}),
      sourceIds: proposal.sources.map((source) => source.id),
      sessions: proposal.date === null ? [] : [{ date: proposal.date, time: null, place: null, label: null }],
      language: proposal.language,
      style: "decide",
      topicTitles: proposal.sources.map((source) => source.title),
    });
    return { planId: created.planId, jobId: created.jobId } satisfies ExamOutcome;
  },
  view(db, base, proposal, decision): ExamProposalView {
    const made = decision?.state === "applied" ? (decision.outcome as ExamOutcome) : null;
    const exists = !!made && !!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(made.planId);
    const job = made ? jobRow(db, made.jobId) : undefined;
    const state = jobState(job);
    return {
      ...base,
      tool: EXAM_TOOL,
      title: proposal.title,
      subject: proposal.subject,
      date: proposal.date,
      sources: proposal.sources,
      existing: base.state === "stale" ? sameExam(db, proposal.title) : null,
      datePast: proposal.date !== null && proposal.date < startOfDay(Date.now()),
      created: made
        ? {
            planId: made.planId,
            // A build that finished counts as done whatever its row says now, as a map's does.
            job: exists && db.prepare("SELECT status FROM plans WHERE id = ?").pluck().get(made.planId) !== "building" ? "done" : state,
            error: state === "failed" ? (job?.error ?? null) : null,
            activity: state === "working" ? activityOf(made.jobId) : null,
            gone: !exists,
          }
        : null,
    };
  },
};
registerProposalKind(kind);

/** The language a new exam is written in: the profile's, as the exam form starts with the app's. */
function language(db: Database.Database): "it" | "en" {
  const row = db.prepare("SELECT content_language FROM profile LIMIT 1").get() as { content_language: string | null } | undefined;
  return row?.content_language?.toLowerCase().startsWith("en") ? "en" : "it";
}

export function proposeExamTool(db: Database.Database): Tool {
  return {
    name: EXAM_TOOL,
    description: EXAM_DESCRIPTION,
    input: examInput,
    run(turn, raw) {
      if ((turn.tally[EXAM_TOOL] ?? 0) >= 1)
        return {
          isError: true,
          text: "This answer already proposed an exam, and one answer may propose one. Nothing more was proposed: the student can ask for another in their next message.",
        };
      const made = propose<ExamRequest, ExamProposal>(db, turn, EXAM_TOOL, raw as ExamRequest);
      if ("refused" in made) return { isError: true, text: made.refused };
      turn.tally[EXAM_TOOL] = 1;
      const { action: proposal, resultId } = made;
      const { subject, date } = proposal;
      const material = proposal.sources.length
        ? `built from ${proposal.sources.length} source${proposal.sources.length === 1 ? "" : "s"} of the student's Library on ${subject}`
        : `with no material: the Library has nothing on ${subject}, so the student can choose sources or build the path with a few questions from the card`;
      return {
        text: `Shown to the student as a draft to confirm: the exam "${proposal.title}"${date === null ? "" : ` on ${dayKey(date)}`}, ${material}. It does not exist until they create it, and nothing has changed. In one short sentence say what you prepared and that nothing exists until they create it; never say it is created.`,
        shown: { resultId },
      };
    },
  };
}
