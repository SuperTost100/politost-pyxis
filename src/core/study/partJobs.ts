import type Database from "better-sqlite3";
import { IpcError } from "../../shared/ipc";
import type { GenerateInput } from "../engine/generate";
import { planLanguage } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import type { FigureRunner } from "../math/figures";
import { aboutPlan } from "./jobAbout";
import { loadLessonById } from "./lesson";
import { bookMarkdown, requireTopic, type Wording } from "./openLesson";
import {
  choosePartLevel,
  itemWording,
  keyWording,
  partOfText,
  partOffLevel,
  type PartRewrite,
  RECAP_FROM,
  RECAP_MINUTES,
  estimateMinutes,
  liveOutline,
  outlinePassages,
  partBounds,
  partLabel,
  planParts,
  writePart,
  type Outline,
  type OutlinePart,
} from "./parts";

// The job that writes one part of a topic's lesson, and the one place that decides when such a job starts. A part is
// written when the student opens it, and the part after a written part when the student opens that one: never more
// than one part ahead of what the student reads.

export const PART_JOB = "lesson-part";

export type PartJobParams = {
  planId: string;
  topicId: string;
  position: number;
  /** The engine when the job was made; missing when none was set up, so the job fails as `engine-missing`. */
  selection?: GenerateInput["selection"];
  /** A written part written again: at the level the student chose, or at its own level. */
  rewrite?: PartRewrite;
  /** The level the part is written at; without it, the outline's. */
  wording?: Wording;
};

type JobRow = { id: string; state: string; error: string | null };

/** The newest job for one part, which the page and the start rule follow. */
const PART_JOB_SQL = `SELECT id, state, error FROM jobs
  WHERE kind = '${PART_JOB}' AND dismissed = 0
    AND json_extract(params_json, '$.topicId') = ? AND json_extract(params_json, '$.position') = ?
  ORDER BY created_at DESC, rowid DESC LIMIT 1`;

/** A part job of the topic that is queued or running, for any part. */
const BUSY_SQL = `SELECT 1 FROM jobs
  WHERE kind = '${PART_JOB}' AND state IN ('queued', 'running') AND json_extract(params_json, '$.topicId') = ? LIMIT 1`;

const LIVE = new Set(["queued", "running"]);

export function partJob(db: Database.Database, topicId: string, position: number): JobRow | null {
  return (db.prepare(PART_JOB_SQL).get(topicId, position) as JobRow | undefined) ?? null;
}

/** The newest job of each part of a topic, by position. */
function partJobs(db: Database.Database, topicId: string): Map<number, JobRow> {
  const rows = db
    .prepare(
      `SELECT id, state, error, json_extract(params_json, '$.position') AS position FROM jobs
       WHERE kind = '${PART_JOB}' AND dismissed = 0 AND json_extract(params_json, '$.topicId') = ?
       ORDER BY created_at, rowid`,
    )
    .all(topicId) as Array<JobRow & { position: number }>;
  return new Map(rows.map((row) => [row.position, row]));
}

/** The page that waits on a part knows its job by this. */
export function partRef(topicId: string, position: number): string {
  return `${topicId}:${position}`;
}

/** The engine for a new job, or none when no engine is set up: the job then fails as `engine-missing` when it runs. */
function currentSelection(db: Database.Database): GenerateInput["selection"] | undefined {
  try {
    return selectionFor(db, "lesson");
  } catch (error) {
    if (error instanceof IpcError && error.code === "engine-missing") return undefined;
    throw error;
  }
}

/** "Parte 4 · Limitati, compatti, connessi" in the plan's language, the recap by its title; none before the outline. */
function partTitle(db: Database.Database, params: PartJobParams): string | null {
  const outline = liveOutline(db, params.topicId);
  const part = outline?.parts.find((entry) => entry.position === params.position);
  if (!outline || !part || outline.parts.length === 1) return null;
  return part.kind === "recap" ? part.title : `${partLabel(planLanguage(db, params.planId), part.position)} · ${part.title}`;
}

export function registerPartJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
  options: { python?: FigureRunner | null } = {},
): void {
  runner.register(PART_JOB, {
    jobClass: "model-cli",
    // The part ahead is needed within the minutes the student spends on the current one.
    interactive: true,
    about: (params) => aboutPlan(db, (params as PartJobParams).planId, (params as PartJobParams).topicId),
    title: (params) => partTitle(db, params as PartJobParams),
    ref: (params) => partRef((params as PartJobParams).topicId, (params as PartJobParams).position),
    retryParams: (params) => ({ ...(params as PartJobParams), selection: selectionFor(db, "lesson") }),
    steps: [
      {
        name: "outline",
        label: "jobs.lessonOutline",
        async run(ctx) {
          const params = ctx.params as PartJobParams;
          // No engine, no outline: a topic of one part would be planned without a call, but its part cannot be written.
          const selection = params.selection ?? selectionFor(db, "lesson");
          await planParts(db, { planId: params.planId, topicId: params.topicId, selection, run, signal: ctx.signal });
          return true;
        },
      },
      {
        name: "write",
        label: "jobs.lessonPart",
        async run(ctx) {
          const params = ctx.params as PartJobParams;
          await writePart(db, {
            planId: params.planId,
            topicId: params.topicId,
            position: params.position,
            selection: params.selection ?? selectionFor(db, "lesson"),
            ...(params.rewrite ? { rewrite: params.rewrite } : {}),
            ...(params.wording ? { wording: params.wording } : {}),
            run,
            signal: ctx.signal,
            ...(options.python === undefined ? {} : { python: options.python }),
          });
          return true;
        },
      },
    ],
  });
}

export type PartStart = { planId: string; topicId: string; position: number };

/**
 * The one place a part job starts, in one transaction. `open`: the student opened the part, so an unwritten part's
 * job starts, resumes or is retried, and one already queued or running is left to finish. `ahead`: the student opened
 * the written part before it, so the part's job starts or resumes only when no part job of the topic is queued or
 * running, and a failed or cancelled one is left for the student, so a failing call never repeats in the background.
 * At any time a topic has at most one job ahead of what the student reads, plus the jobs of parts the student opened.
 */
function startPart(db: Database.Database, runner: Runner, input: PartStart, reason: "open" | "ahead"): void {
  db.transaction(() => {
    const outline = liveOutline(db, input.topicId);
    const part = outline?.parts.find((entry) => entry.position === input.position);
    // Before the outline exists only the first part can be asked for: its job makes the outline.
    if (outline ? !part : input.position !== 1) throw new Error("part-missing");
    if (part?.itemId) return;
    const job = partJob(db, input.topicId, input.position);
    if (job && LIVE.has(job.state)) return;
    if (reason === "ahead") {
      if (!job || job.state === "interrupted" || job.state === "succeeded") {
        if (db.prepare(BUSY_SQL).get(input.topicId)) return;
      } else return;
    }
    if (job?.state === "interrupted") runner.resume(job.id);
    else if (job?.state === "failed" || job?.state === "cancelled") runner.retry(job.id);
    else {
      const params: PartJobParams = { ...input, selection: currentSelection(db) };
      runner.start(PART_JOB, params);
    }
  })();
}

/** The student opened part `position`: write it unless it is written or being written. */
export function ensurePart(db: Database.Database, runner: Runner, input: PartStart): void {
  startPart(db, runner, input, "open");
}

/** The student opened the written part `position`: write the part after it, at most one ahead. */
export function ensureAhead(db: Database.Database, runner: Runner, input: PartStart): void {
  const outline = liveOutline(db, input.topicId);
  const opened = outline?.parts.find((entry) => entry.position === input.position);
  const next = outline?.parts.find((entry) => entry.position === input.position + 1);
  if (!opened?.itemId || !next || next.itemId) return;
  startPart(db, runner, { ...input, position: next.position }, "ahead");
}

// Level and rewrites on a written part. The student's choice writes the part again in a job of its own; the part ahead
// that was written at another level than the one chosen is written again as the part ahead, under the same rule.

type RewriteJob = JobRow & { rewrite: PartRewrite | null; wording: Wording | null };

/** The newest job for one part, with what it rewrites. */
function rewriteJob(db: Database.Database, topicId: string, position: number): RewriteJob | null {
  const row = db
    .prepare(
      `SELECT id, state, error, json_extract(params_json, '$.rewrite') AS rewrite, json_extract(params_json, '$.wording') AS wording
       FROM jobs WHERE kind = '${PART_JOB}' AND dismissed = 0
         AND json_extract(params_json, '$.topicId') = ? AND json_extract(params_json, '$.position') = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(topicId, position) as RewriteJob | undefined;
  return row ?? null;
}

export type RewriteStart = PartStart & { rewrite: PartRewrite; wording: Wording };

/**
 * Writes a written part again, in one transaction. `choice`: the student asked for it, so the job starts, and the same
 * rewrite stopped before is resumed or retried; nothing starts while a job for the part is queued or running. `ahead`:
 * the part after the one the student opened is at another level than the one chosen, so it is written again only when
 * no part job of the topic is queued or running, and a rewrite of it that failed is left for the student.
 */
function startRewrite(db: Database.Database, runner: Runner, input: RewriteStart, reason: "choice" | "ahead"): void {
  db.transaction(() => {
    const part = liveOutline(db, input.topicId)?.parts.find((entry) => entry.position === input.position);
    if (!part?.itemId) throw new Error("part-missing");
    const job = rewriteJob(db, input.topicId, input.position);
    if (job && LIVE.has(job.state)) return;
    const same = job?.rewrite === input.rewrite && job.wording === input.wording;
    if (reason === "ahead") {
      if (job?.rewrite && (job.state === "failed" || job.state === "cancelled")) return;
      if (db.prepare(BUSY_SQL).get(input.topicId)) return;
    }
    if (same && job?.state === "interrupted") runner.resume(job.id);
    else if (same && (job?.state === "failed" || job?.state === "cancelled")) runner.retry(job.id);
    else {
      const params: PartJobParams = {
        planId: input.planId,
        topicId: input.topicId,
        position: input.position,
        selection: currentSelection(db),
        rewrite: input.rewrite,
        wording: input.wording,
      };
      runner.start(PART_JOB, params);
    }
  })();
}

/**
 * The student's choice on part `position` (`study.part` with `wording` or `regenerate`). On a written part, a level
 * the part's text is not at points the part at the text written at that level before, or writes it again; `regenerate`
 * writes it again at the chosen level, or at the level of its text. On a part not written yet a level is kept on the
 * outline, and the part is written at it.
 */
export function choosePart(
  db: Database.Database,
  runner: Runner,
  input: PartStart & { wording?: Wording; regenerate?: boolean },
): void {
  const outline = liveOutline(db, input.topicId);
  const part = outline?.parts.find((entry) => entry.position === input.position);
  if (!outline || !part) throw new Error("part-missing");
  if (!part.itemId) {
    if (input.wording) db.prepare("UPDATE lesson_outlines SET wording = ? WHERE id = ?").run(input.wording, outline.id);
    return;
  }
  const at = { planId: input.planId, topicId: input.topicId, position: input.position };
  if (input.regenerate) {
    const wording = input.wording ?? itemWording(db, part.itemId) ?? "balanced";
    startRewrite(db, runner, { ...at, rewrite: input.wording ? "level" : "again", wording }, "choice");
    return;
  }
  if (input.wording && choosePartLevel(db, { ...at, wording: input.wording }) === "write")
    startRewrite(db, runner, { ...at, rewrite: "level", wording: input.wording }, "choice");
}

/**
 * The student opened the written part `position`, and the part after it is written but not done, at another level
 * than the one chosen on the outline: it is written again at that level as the part ahead, or pointed at its text at
 * that level when one was written before.
 */
export function ensureAheadLevel(db: Database.Database, runner: Runner, input: PartStart): void {
  const outline = liveOutline(db, input.topicId);
  const opened = outline?.parts.find((entry) => entry.position === input.position);
  const next = outline?.parts.find((entry) => entry.position === input.position + 1);
  if (!outline?.wording || !opened?.itemId || !next?.itemId || next.doneAt !== null || !partOffLevel(db, outline, next)) return;
  if (db.prepare(BUSY_SQL).get(input.topicId)) return;
  const wording = outline.wording as Wording;
  const at = { planId: input.planId, topicId: input.topicId, position: next.position };
  if (choosePartLevel(db, { ...at, wording }) === "write") startRewrite(db, runner, { ...at, rewrite: "level", wording }, "ahead");
}

/** A written part being written again, or whose rewrite failed: what the page shows over its text. */
export type PartRewriteView = {
  state: "writing" | "failed";
  rewrite: PartRewrite;
  /** The level the new text is written at. */
  wording: Wording;
  /** The job's error as the runner stored it; null while writing, and for a rewrite stopped by a quit. */
  error: string | null;
  jobId: string;
};

function rewriteView(db: Database.Database, topicId: string, position: number): PartRewriteView | null {
  const job = rewriteJob(db, topicId, position);
  if (!job?.rewrite || !job.wording) return null;
  // A rewrite stopped by a quit shows as failed, and Riprova resumes it; one the student cancelled shows nothing.
  const state = LIVE.has(job.state) ? "writing" : job.state === "failed" || job.state === "interrupted" ? "failed" : null;
  if (!state) return null;
  return { state, rewrite: job.rewrite, wording: job.wording, error: state === "failed" ? job.error : null, jobId: job.id };
}

export type PartView = {
  id: string;
  position: number;
  kind: OutlinePart["kind"];
  title: string;
  about: string;
  minutes: number;
  state: "unwritten" | "writing" | "written" | "failed";
  done: boolean;
};

export type OutlineView = {
  id: string;
  parts: PartView[];
  /** Teaching parts, the recap left out. */
  teaching: number;
  /** Teaching parts done. */
  done: number;
  /** Minutes of the parts not done, the recap included. */
  minutesLeft: number;
};

function partView(part: OutlinePart, job: JobRow | undefined): PartView {
  return {
    id: part.id,
    position: part.position,
    kind: part.kind,
    title: part.title,
    about: part.about,
    minutes: part.minutes,
    state: part.itemId
      ? "written"
      : job && LIVE.has(job.state)
        ? "writing"
        : job?.state === "failed"
          ? "failed"
          : "unwritten",
    done: part.doneAt !== null,
  };
}

function outlineView(db: Database.Database, outline: Outline): OutlineView {
  const jobs = partJobs(db, outline.topicId);
  const teaching = outline.parts.filter((part) => part.kind === "part");
  return {
    id: outline.id,
    parts: outline.parts.map((part) => partView(part, jobs.get(part.position))),
    teaching: teaching.length,
    done: teaching.filter((part) => part.doneAt !== null).length,
    minutesLeft: outline.parts.filter((part) => part.doneAt === null).reduce((sum, part) => sum + part.minutes, 0),
  };
}

/**
 * A topic's parts for the path (`study.parts`), and for a topic not planned yet an estimate of its teaching parts and
 * minutes from the same character rules the planning uses. Reads only.
 */
export function topicParts(db: Database.Database, input: { planId: string; topicId: string }) {
  requireTopic(db, input.planId, input.topicId);
  const outline = liveOutline(db, input.topicId);
  const passages = outlinePassages(db, input.topicId);
  const chars = passages.reduce((sum, passage) => sum + passage.text.length, 0);
  const bounds = partBounds(chars, passages.length);
  const parts = bounds?.target ?? 1;
  const minutes =
    parts * estimateMinutes(chars / parts) + (parts >= RECAP_FROM ? RECAP_MINUTES : 0);
  return { outline: outline ? outlineView(db, outline) : null, estimate: { parts, minutes } };
}

/** The topic has a lesson written before parts existed: a model's, or one imported from a plan file. */
function hasOldLesson(db: Database.Database, planId: string, topicId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM items WHERE plan_id = ? AND topic_id = ? AND kind = 'lesson' AND engine_provider IS NOT NULL
         AND COALESCE(prompt_template, '') <> 'lesson.part' LIMIT 1`,
    )
    .get(planId, topicId);
}

export type PartInput = {
  planId: string;
  topicId: string;
  /** Without it, the first part not done, or part 1 when all are. */
  position?: number;
  /** Start, resume or retry the part's job. Without it the call only reads, so polling never starts work. */
  write?: boolean;
  /** A saved lesson item of the topic: a part opens as that part, any other lesson in the existing reader. */
  itemId?: string;
  /** The level the student chose on the part (`choosePart`). */
  wording?: Wording;
  /** Write the written part again (`choosePart`). */
  regenerate?: boolean;
};

/** A lesson as the reader shows it, without its answers, sources and citations, which the handler adds. */
type PartLesson = {
  markdown: string;
  passageIds: string[];
  itemId?: string;
  /** The level the part's text is at. */
  wording?: Wording;
  figures?: Record<string, string>;
  general?: boolean;
  fallback?: boolean;
  fallbackReason?: string;
};

export type PartResult =
  | { mode: "legacy" }
  | {
      mode: "parts";
      outline: OutlineView | null;
      position: number;
      state: "planning" | "writing" | "written" | "failed" | "book";
      /** The part job's error as the runner stored it, which the jobs list reads too; null when it has none. */
      error: string | null;
      lesson: PartLesson | null;
      summary: string | null;
      next: PartView | null;
      replaces: { itemId: string } | null;
      /** The part written again, or a rewrite of it that failed; null otherwise. */
      rewrite: PartRewriteView | null;
    };

/**
 * Opens one part of a topic's lesson (`study.part`). `mode: "legacy"` sends the page to the existing reader: a lesson
 * item that is not a part, a topic with a lesson written before parts and no outline, and the developer agent lesson.
 * A written part comes with its text and starts the part after it (`ensureAhead`), with or without `write`. An
 * unwritten one comes with the state of its job: `planning` before the outline exists, then `writing`, `failed` when
 * its job failed or stopped (with the job's error, or null when it was cancelled, interrupted or never started), and
 * `book` when no engine is set up, with the part's passages (the topic's before the outline) as book text, not saved.
 */
export function openPart(
  db: Database.Database,
  runner: Runner | undefined,
  input: PartInput,
  options: { agentLesson?: boolean } = {},
): PartResult {
  requireTopic(db, input.planId, input.topicId);
  if (options.agentLesson) return { mode: "legacy" };
  let position = input.position;
  if (input.itemId) {
    if (!loadLessonById(db, { planId: input.planId, topicId: input.topicId, itemId: input.itemId }))
      throw new Error("item-missing");
    // A part's text at another level, opened by its item (a finished step), opens as its part too.
    const owner = partOfText(db, input.topicId, input.itemId)?.position;
    if (owner === undefined) return { mode: "legacy" };
    position ??= owner;
  }
  let outline = liveOutline(db, input.topicId);
  if (!outline && hasOldLesson(db, input.planId, input.topicId)) return { mode: "legacy" };
  position ??= outline?.parts.find((part) => part.doneAt === null)?.position ?? 1;
  const at = { planId: input.planId, topicId: input.topicId, position };
  if (outline ? !outline.parts.some((part) => part.position === position) : position !== 1)
    throw new Error("part-missing");
  if ((input.wording || input.regenerate) && runner) {
    choosePart(db, runner, { ...at, wording: input.wording, regenerate: input.regenerate });
    outline = liveOutline(db, input.topicId);
  }
  if (input.write && runner) ensurePart(db, runner, at);
  let part = outline?.parts.find((entry) => entry.position === position);
  if (part?.itemId && runner) {
    ensureAhead(db, runner, at);
    ensureAheadLevel(db, runner, at);
    outline = liveOutline(db, input.topicId);
    part = outline?.parts.find((entry) => entry.position === position);
  }
  const job = partJob(db, input.topicId, position);
  const saved = part?.itemId
    ? loadLessonById(db, { planId: input.planId, topicId: input.topicId, itemId: part.itemId })
    : null;
  const after = outline?.parts.find((entry) => entry.position === position + 1);
  const view = outline ? outlineView(db, outline) : null;
  const base = {
    mode: "parts" as const,
    outline: view,
    position,
    summary: part?.summary ?? null,
    next: after && view ? (view.parts.find((entry) => entry.position === after.position) ?? null) : null,
    replaces: null,
    rewrite: part?.itemId ? rewriteView(db, input.topicId, position) : null,
  };
  if (saved)
    return {
      ...base,
      state: "written",
      error: null,
      lesson: {
        markdown: saved.markdown,
        passageIds: saved.passageIds,
        itemId: saved.itemId,
        ...(keyWording(saved.key) ? { wording: keyWording(saved.key) } : {}),
        ...(Object.keys(saved.figures).length ? { figures: saved.figures } : {}),
        ...(saved.grounding === "general" ? { general: true } : {}),
      },
    };
  if (job && LIVE.has(job.state)) return { ...base, state: outline ? "writing" : "planning", error: null, lesson: null };
  const error = job?.state === "failed" ? job.error : null;
  if (error?.includes("engine-missing")) {
    const own = new Set(part?.passageIds ?? []);
    const passages = outlinePassages(db, input.topicId);
    const shown = own.size > 0 ? passages.filter((passage) => own.has(passage.id)) : passages;
    return {
      ...base,
      state: "book",
      error,
      lesson: {
        markdown: bookMarkdown(shown.map((passage) => ({ text: passage.text, section_path: passage.section }))),
        passageIds: shown.map((passage) => passage.id),
        fallback: true,
        fallbackReason: "engines.errors.engine-missing",
      },
    };
  }
  return { ...base, state: "failed", error, lesson: null };
}
