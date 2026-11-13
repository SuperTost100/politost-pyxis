import type Database from "better-sqlite3";
import { IpcError } from "../../shared/ipc";
import type { GenerateInput } from "../engine/generate";
import { planLanguage } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import type { FigureRunner } from "../math/figures";
import { aboutPlan } from "./jobAbout";
import { loadLessonById } from "./lesson";
import { bookMarkdown, requireTopic } from "./openLesson";
import {
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
};

/** A lesson as the reader shows it, without its answers, sources and citations, which the handler adds. */
type PartLesson = {
  markdown: string;
  passageIds: string[];
  itemId?: string;
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
    const owner = liveOutline(db, input.topicId)?.parts.find((part) => part.itemId === input.itemId);
    if (!owner) return { mode: "legacy" };
    position ??= owner.position;
  }
  let outline = liveOutline(db, input.topicId);
  if (!outline && hasOldLesson(db, input.planId, input.topicId)) return { mode: "legacy" };
  position ??= outline?.parts.find((part) => part.doneAt === null)?.position ?? 1;
  const at = { planId: input.planId, topicId: input.topicId, position };
  if (outline ? !outline.parts.some((part) => part.position === position) : position !== 1)
    throw new Error("part-missing");
  if (input.write && runner) ensurePart(db, runner, at);
  let part = outline?.parts.find((entry) => entry.position === position);
  if (part?.itemId && runner) {
    ensureAhead(db, runner, at);
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
