import type Database from "better-sqlite3";
import { IpcError } from "../../shared/ipc";
import type { GenerateInput } from "../engine/generate";
import { planLanguage } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import type { FigureRunner } from "../math/figures";
import { aboutPlan } from "./jobAbout";
import { loadLessonById } from "./lesson";
import { oldLesson } from "./oldLessons";
import { partOfText } from "./partText";
import { bookMarkdown, requireTopic, type Wording } from "./openLesson";
import {
  choosePartLevel,
  itemWording,
  keyWording,
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
  outlineShown,
  shownOutline,
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
  /**
   * A rewrite of a part the student did not choose: the part ahead, or a part reached, at the outline's level. Stored
   * with the job, so a retry or a resume keeps it, and it never sets the outline's level (`writePart`).
   */
  ahead?: true;
  /** Old lessons in parts: the lesson written before parts that the outline this job makes rewrites. */
  replaces?: string;
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

/**
 * Marks the part a job was writing as not written by a failed or cancelled write. The mark is on the part's row, so it
 * outlives a job the student dismissed in Attività, and the part ahead still waits for the student.
 */
function markWriteFailed(db: Database.Database, params: PartJobParams): void {
  db.prepare(
    `UPDATE lesson_parts SET write_failed_at = ?
     WHERE position = ? AND item_id IS NULL
       AND outline_id = (SELECT id FROM lesson_outlines WHERE topic_id = ? AND retired_at IS NULL)`,
  ).run(Date.now(), params.position, params.topicId);
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
    // A quit is neither: the next start marks the job interrupted, to be resumed.
    onFailed: (params) => markWriteFailed(db, params as PartJobParams),
    onCancelled: (params) => markWriteFailed(db, params as PartJobParams),
    steps: [
      {
        name: "outline",
        label: "jobs.lessonOutline",
        async run(ctx) {
          const params = ctx.params as PartJobParams;
          // No engine, no outline: a topic of one part would be planned without a call, but its part cannot be written.
          const selection = params.selection ?? selectionFor(db, "lesson");
          await planParts(db, {
            planId: params.planId,
            topicId: params.topicId,
            selection,
            run,
            signal: ctx.signal,
            ...(params.replaces ? { replaces: params.replaces } : {}),
          });
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
            ...(params.ahead ? { ahead: true } : {}),
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

export type PartStart = {
  planId: string;
  topicId: string;
  position: number;
  /** Old lessons in parts: the lesson written before parts that a new job's outline rewrites. */
  replaces?: string;
};

/**
 * The one place a part job starts, in one transaction. `open`: the student opened the part, so an unwritten part's
 * job starts, resumes or is retried, and one already queued or running is left to finish; once a job is queued, the
 * part's mark of a failed or cancelled write is cleared. `ahead`: the student opened the written part before it, so the
 * part's job starts or resumes only when no part job of the topic is queued or running. A part whose last write failed
 * or was cancelled is left for the student, by its job or, once that job is dismissed, by the mark on its row, so a
 * failing call never repeats in the background. At any time a topic has at most one job ahead of what the student
 * reads, plus the jobs of parts the student opened.
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
      if (part?.writeFailedAt != null) return;
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
    // A retry the runner refused (no engine to retry with) leaves the job failed, and the mark with it.
    if (part?.writeFailedAt != null && LIVE.has(partJob(db, input.topicId, input.position)?.state ?? ""))
      db.prepare("UPDATE lesson_parts SET write_failed_at = NULL WHERE id = ?").run(part.id);
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
 * no part job of the topic is queued or running, and a rewrite of it that failed is left for the student. `reached`:
 * the student opened such a part, which is written again whatever else runs, unless a rewrite of it failed. The jobs
 * of `ahead` and `reached` are marked `ahead`, so they never set the outline's level.
 */
function startRewrite(db: Database.Database, runner: Runner, input: RewriteStart, reason: "choice" | "ahead" | "reached"): void {
  db.transaction(() => {
    const part = liveOutline(db, input.topicId)?.parts.find((entry) => entry.position === input.position);
    if (!part?.itemId) throw new Error("part-missing");
    const job = rewriteJob(db, input.topicId, input.position);
    if (job && LIVE.has(job.state)) return;
    const same = job?.rewrite === input.rewrite && job.wording === input.wording;
    if (reason !== "choice" && job?.rewrite && (job.state === "failed" || job.state === "cancelled")) return;
    if (reason === "ahead" && db.prepare(BUSY_SQL).get(input.topicId)) return;
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
        ...(reason === "choice" ? {} : { ahead: true as const }),
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
  // A replacement with no part written is not the topic's lesson yet (`outlineShown`): the old lesson stands in its
  // place, so the plan takes no level and no rewrite until Riprova writes part 1.
  if (!outlineShown(outline)) throw new Error("parts-not-shown");
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
 * Whether a part follows the level chosen on the outline but is not at it: written, not done, at another level, and
 * after a part whose text is at the chosen level, which is where the level was chosen ("Vale per questa parte e per
 * le prossime"). A part done keeps the text it was read in, and a part before the one the level was chosen on keeps
 * its own.
 */
function followsLevel(db: Database.Database, outline: Outline, part: OutlinePart | undefined): part is OutlinePart {
  if (!outline.wording || !part?.itemId || part.doneAt !== null || !partOffLevel(db, outline, part)) return false;
  return outline.parts.some((entry) => entry.position < part.position && entry.itemId && !partOffLevel(db, outline, entry));
}

/**
 * The student opened the written part `position`, and the part after it follows the chosen level but is not at it
 * (`followsLevel`): it is written again at that level as the part ahead, or pointed at its text at that level when
 * one was written before.
 */
export function ensureAheadLevel(db: Database.Database, runner: Runner, input: PartStart): void {
  const outline = liveOutline(db, input.topicId);
  const opened = outline?.parts.find((entry) => entry.position === input.position);
  const next = outline?.parts.find((entry) => entry.position === input.position + 1);
  if (!outline || !opened?.itemId || !followsLevel(db, outline, next)) return;
  if (db.prepare(BUSY_SQL).get(input.topicId)) return;
  const wording = outline.wording as Wording;
  const at = { planId: input.planId, topicId: input.topicId, position: next.position };
  if (choosePartLevel(db, { ...at, wording }) === "write") startRewrite(db, runner, { ...at, rewrite: "level", wording }, "ahead");
}

/**
 * The student opened a part that follows the chosen level but is not at it (`followsLevel`): written ahead before the
 * level changed, or while it changed. It is written again at the chosen level now that it is reached, or pointed at
 * its text at that level written before.
 */
export function ensureLevelReached(db: Database.Database, runner: Runner, input: PartStart): void {
  const outline = liveOutline(db, input.topicId);
  const opened = outline?.parts.find((entry) => entry.position === input.position);
  if (!outline || !followsLevel(db, outline, opened)) return;
  const wording = outline.wording as Wording;
  if (choosePartLevel(db, { ...input, wording }) === "write") startRewrite(db, runner, { ...input, rewrite: "level", wording }, "reached");
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
        : job?.state === "failed" || part.writeFailedAt !== null
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
 * A topic's parts for the path (`study.parts`), when its outline is the lesson the student has (`shownOutline`), and
 * for a topic not planned yet, or whose rewrite in parts has no part written, an estimate of its teaching parts and
 * minutes from the same character rules the planning uses. Reads only.
 */
export function topicParts(db: Database.Database, input: { planId: string; topicId: string }) {
  requireTopic(db, input.planId, input.topicId);
  const outline = shownOutline(db, input.topicId);
  const passages = outlinePassages(db, input.topicId);
  const chars = passages.reduce((sum, passage) => sum + passage.text.length, 0);
  const bounds = partBounds(chars, passages.length);
  const parts = bounds?.target ?? 1;
  const minutes =
    parts * estimateMinutes(chars / parts) + (parts >= RECAP_FROM ? RECAP_MINUTES : 0);
  return { outline: outline ? outlineView(db, outline) : null, estimate: { parts, minutes } };
}

// Old lessons in parts. A topic with a lesson written before parts and no outline: an unfinished lesson is rewritten in
// parts when the student opens it, and a finished one opens in the existing reader until the student asks for parts
// ("Riscrivi in parti", `rewriteInParts`). The outline names the old lesson it rewrites (`replaces_item_id`), whose
// row, answers and citations stay.

/** How the existing reader shows a lesson written before parts: finished, with "Riscrivi in parti"; or an earlier version. */
export type OldMode = "finished" | "earlier";

/**
 * A finished old lesson opens in parts only while the rewrite the student asked for is under way: part 1's job is
 * queued or running, or the page asked for a part (`?part=1`, where "Riscrivi in parti" leads) and the job failed or
 * stopped with Pyxis, so the page can say so and offer Riprova. A cancelled rewrite leaves the lesson as it was.
 */
function rewriting(db: Database.Database, topicId: string, position: number | undefined): boolean {
  const job = partJob(db, topicId, 1);
  if (!job) return false;
  return LIVE.has(job.state) || (position !== undefined && (job.state === "failed" || job.state === "interrupted"));
}

/**
 * A saved lesson that is no part, opened by its item. While the topic has an outline, shown or still a replacement
 * with no part written, or part 1's job is making one, the old lesson is the earlier version: read as it was, with
 * nothing that could rewrite or overwrite the row the rewrite keeps. Otherwise an unfinished old lesson is the earlier
 * version of the rewrite its next open starts, a finished one keeps its menu and gets "Riscrivi in parti", and any
 * other lesson (book text, a topic without old lessons) opens as it was before.
 */
function legacyItem(db: Database.Database, planId: string, topicId: string): PartResult {
  const job = partJob(db, topicId, 1);
  if (liveOutline(db, topicId) || (job && LIVE.has(job.state))) return { mode: "legacy", old: "earlier" };
  const old = oldLesson(db, planId, topicId);
  if (!old) return { mode: "legacy" };
  return { mode: "legacy", old: old.finished ? "finished" : "earlier" };
}

/** The old lesson an outline rewrote, while its row is still there. */
function replacedItem(db: Database.Database, outline: Outline): { itemId: string } | null {
  if (!outline.replacesItemId) return null;
  return db.prepare("SELECT 1 FROM items WHERE id = ?").get(outline.replacesItemId) ? { itemId: outline.replacesItemId } : null;
}

/**
 * "Riscrivi in parti" on a finished lesson written before parts (`study.rewriteInParts`): starts part 1's job, whose
 * outline names the old lesson, or retries one that failed, keeping an outline it saved. The topic's lesson step
 * stays, so its progress does not move back; the parts start not done. A topic already in parts, or with no old
 * lesson, has nothing to rewrite.
 */
export function rewriteInParts(db: Database.Database, runner: Runner, input: { planId: string; topicId: string }): { ok: true } {
  requireTopic(db, input.planId, input.topicId);
  if (shownOutline(db, input.topicId)) throw new Error("parts-exist");
  const old = oldLesson(db, input.planId, input.topicId);
  if (!old) throw new Error("lesson-missing");
  ensurePart(db, runner, { planId: input.planId, topicId: input.topicId, position: 1, replaces: old.itemId });
  return { ok: true };
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
  | { mode: "legacy"; old?: OldMode }
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
      /** The lesson written before parts that this lesson in parts rewrites, or is about to. */
      replaces: { itemId: string } | null;
      /** The part written again, or a rewrite of it that failed; null otherwise. */
      rewrite: PartRewriteView | null;
    };

/**
 * Opens one part of a topic's lesson (`study.part`). `mode: "legacy"` sends the page to the existing reader: a lesson
 * item that is not a part, a finished lesson written before parts on a topic with no outline (`oldLesson`), and the
 * developer agent lesson. An unfinished lesson written before parts is rewritten in parts: its first open with `write`
 * starts part 1's job with the old lesson named, and `replaces` names it until the topic is in parts. A written part comes with its text and starts the part after it (`ensureAhead`), with or without `write`. An
 * unwritten one comes with the state of its job: `planning` before the outline exists, then `writing`, `failed` when
 * its job failed or stopped (with the job's error, or null when it was cancelled, interrupted, never started or
 * dismissed), and `book` when no engine is set up, with the part's passages (the topic's before the outline) as book
 * text, not saved.
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
    const text = partOfText(db, input.itemId);
    if (!text || text.outlineId !== liveOutline(db, input.topicId)?.id) return legacyItem(db, input.planId, input.topicId);
    position ??= text.position;
  }
  // The stored outline, shown or not: a replacement with no part written opens on its working state or its failure,
  // which show the old lesson in its place (`outlineShown` is the rule; the renderer's `oldLessonView` reads it from
  // `replaces` and the parts' states), and Riprova goes on from it.
  let outline = liveOutline(db, input.topicId);
  let replaces = outline ? replacedItem(db, outline) : null;
  if (!outline) {
    const old = oldLesson(db, input.planId, input.topicId);
    if (old?.finished && !rewriting(db, input.topicId, input.position)) return { mode: "legacy", old: "finished" };
    if (old) replaces = { itemId: old.itemId };
  }
  position ??= outline?.parts.find((part) => part.doneAt === null)?.position ?? 1;
  const at = { planId: input.planId, topicId: input.topicId, position };
  if (outline ? !outline.parts.some((part) => part.position === position) : position !== 1)
    throw new Error("part-missing");
  if ((input.wording || input.regenerate) && runner) {
    choosePart(db, runner, { ...at, wording: input.wording, regenerate: input.regenerate });
    outline = liveOutline(db, input.topicId);
  }
  // Before the outline exists, the job that makes it names the old lesson it rewrites.
  if (input.write && runner) ensurePart(db, runner, !outline && replaces ? { ...at, replaces: replaces.itemId } : at);
  let part = outline?.parts.find((entry) => entry.position === position);
  if (part?.itemId && runner) {
    ensureAhead(db, runner, at);
    ensureAheadLevel(db, runner, at);
    ensureLevelReached(db, runner, at);
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
    replaces,
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
