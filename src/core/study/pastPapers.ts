import { setTimeout as wait } from "node:timers/promises";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { IpcError, SIMULATION_MAX_MINUTES, SIMULATION_MIN_MINUTES } from "../../shared/ipc";
import { generate, type GenerateInput } from "../engine/generate";
import {
  languageName,
  planLanguage,
  promptProvenance,
  systemPrompt,
} from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { QUIZ_MAX_QUESTIONS, questionFlagged, saveQuiz, startAttempt } from "./attempt";
import { flaggedIds } from "./flags";
import { acrossTopics } from "./topicQuiz";

/**
 * Past exams (appelli). A student attaches an old paper to a plan as a source with the role `past_paper`. One model
 * call reads its questions; the result is kept in `plan_sources.paper_json`. Simulations copy the papers' structure,
 * and the questions can be practised. Papers never feed topics, lessons or citations, and they are not exported.
 */

export const PAPER_TYPES = ["open", "choice", "numeric", "proof"] as const;
export type PaperType = (typeof PAPER_TYPES)[number];
const PAPER_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type PaperDifficulty = (typeof PAPER_DIFFICULTIES)[number];

/** Files of one paper stay under this many, and the text sent to the model under this many characters. */
const PAPER_MAX_FILES = 12;
const PAPER_MAX_CHARS = 60_000;
/** A simulation never builds fewer or more questions than this, whatever the papers hold. */
const STYLE_MIN_QUESTIONS = 3;
const STYLE_MAX_QUESTIONS = 20;

const paperSchema = z.object({
  title: z.string().trim().max(200),
  minutes: z.number().int().min(5).max(480).nullable(),
  totalPoints: z.number().min(1).max(1000).nullable(),
  questions: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(5000),
        type: z.enum(PAPER_TYPES),
        points: z.number().min(0).max(1000).nullable(),
        minutes: z.number().int().min(1).max(480).nullable(),
        difficulty: z.enum(PAPER_DIFFICULTIES),
        reference: z.string().trim().min(1).max(4000),
      }),
    )
    .max(60),
});

export type PastQuestion = {
  id: string;
  text: string;
  type: PaperType;
  points: number | null;
  minutes: number | null;
  difficulty: PaperDifficulty;
  reference: string;
};

export type StoredPaper = {
  v: 1;
  title: string;
  minutes: number | null;
  totalPoints: number | null;
  questions: PastQuestion[];
  read: { provider: string; model: string; template: string; version: string; at: number };
};

/** The row of every file after the first of a paper that has several. */
type PartOf = { partOf: string };

type ReadParams = {
  planId: string;
  /** The paper's first file; its row holds the result. */
  sourceId: string;
  /** The other files of the paper, in reading order. */
  partIds: string[];
  selection: StoredSelection;
  language: string;
};

/** One line of option text on its own line in Markdown: a lettered option starts a new paragraph. */
export function spaceOptions(text: string): string {
  return text.replace(/\n(?=[A-D][).]\s)/g, "\n\n");
}

function parsePaper(json: string | null): StoredPaper | null {
  if (!json) return null;
  const value = JSON.parse(json) as Partial<StoredPaper> & Partial<PartOf>;
  return value.v === 1 ? (value as StoredPaper) : null;
}

type PaperRow = {
  source_id: string;
  title: string;
  created_at: number;
  paper_json: string | null;
};

/** The lead row of each past paper of the plan, oldest first. */
function leadRows(db: Database.Database, planId: string): PaperRow[] {
  return db
    .prepare(
      `SELECT ps.source_id, s.title, s.created_at, ps.paper_json
       FROM plan_sources ps JOIN sources s ON s.id = ps.source_id
       WHERE ps.plan_id = ? AND ps.role = 'past_paper'
         AND (ps.paper_json IS NULL OR json_extract(ps.paper_json, '$.partOf') IS NULL)
       ORDER BY s.created_at, s.id`,
    )
    .all(planId) as PaperRow[];
}

/** The other files of a paper, in the order they were added. */
function partIds(db: Database.Database, planId: string, leadId: string): string[] {
  return (
    db
      .prepare(
        `SELECT source_id AS id FROM plan_sources WHERE plan_id = ? AND role = 'past_paper' AND json_extract(paper_json, '$.partOf') = ? ORDER BY rowid`,
      )
      .all(planId, leadId) as Array<{ id: string }>
  ).map((row) => row.id);
}

function readJob(db: Database.Database, planId: string, sourceId: string) {
  return db
    .prepare(
      `SELECT id, state, error FROM jobs WHERE kind = 'paper-read' AND json_extract(params_json, '$.planId') = ? AND json_extract(params_json, '$.sourceId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(planId, sourceId) as
    | { id: string; state: string; error: string | null }
    | undefined;
}

/** The papers whose questions have been read. */
function readyPapers(db: Database.Database, planId: string) {
  return leadRows(db, planId).flatMap((row) => {
    const paper = parsePaper(row.paper_json);
    return paper && paper.questions.length ? [{ sourceId: row.source_id, paper }] : [];
  });
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

function countBy<T extends string>(keys: readonly T[], values: T[]): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, values.filter((v) => v === key).length])) as Record<T, number>;
}

/** Minutes a paper gives: its printed duration, else the sum of its questions' times when every question has one. */
function paperMinutes(paper: StoredPaper): number | null {
  if (paper.minutes) return paper.minutes;
  const times = paper.questions.map((q) => q.minutes);
  return times.every((m): m is number => m != null) ? times.reduce((a, b) => a + b, 0) : null;
}

export function pastPaperViews(db: Database.Database, planId: string) {
  return leadRows(db, planId).map((row) => {
    const paper = parsePaper(row.paper_json);
    const job = readJob(db, planId, row.source_id);
    const ready = paper != null && paper.questions.length > 0;
    const state = job?.state ?? "failed";
    return {
      sourceId: row.source_id,
      title: paper?.title || row.title,
      /** Every file of the paper, so a picker can leave them out. */
      sourceIds: [row.source_id, ...partIds(db, planId, row.source_id)],
      status: ready
        ? ("ready" as const)
        : state === "queued" || state === "running"
          ? ("reading" as const)
          : state === "interrupted" || state === "cancelled"
            ? state
            : ("failed" as const),
      jobId: ready ? undefined : job?.id,
      error: ready ? undefined : (job?.error ?? undefined),
      questions: paper?.questions.length ?? 0,
      minutes: paper ? paperMinutes(paper) : null,
      points: paper?.totalPoints ?? null,
      types: countBy(PAPER_TYPES, paper?.questions.map((q) => q.type) ?? []),
      provider: paper?.read.provider,
      model: paper?.read.model,
    };
  });
}

/** What the simulation builder copies from the plan's past papers. Null when no paper has been read. */
export type PastStyle = {
  papers: number;
  /** The usual number of questions in one paper, kept within what a simulation builds. */
  questions: number;
  /** The usual duration, when papers give one, held within the time limits of a simulation. */
  minutes: number | null;
  totalPoints: number | null;
  types: Record<PaperType, number>;
  difficulty: Record<PaperDifficulty, number>;
  /** A few question texts, kept short, so the wording and level can be matched. */
  examples: string[];
};

export function pastStyle(db: Database.Database, planId: string): PastStyle | null {
  const papers = readyPapers(db, planId);
  if (!papers.length) return null;
  const all = papers.flatMap(({ paper }) => paper.questions);
  const minutes = papers.flatMap(({ paper }) => paperMinutes(paper) ?? []);
  const points = papers.flatMap(({ paper }) => paper.totalPoints ?? []);
  return {
    papers: papers.length,
    questions: Math.min(
      STYLE_MAX_QUESTIONS,
      Math.max(STYLE_MIN_QUESTIONS, Math.round(median(papers.map(({ paper }) => paper.questions.length)))),
    ),
    minutes: minutes.length
      ? Math.min(SIMULATION_MAX_MINUTES, Math.max(SIMULATION_MIN_MINUTES, Math.round(median(minutes))))
      : null,
    totalPoints: points.length ? Math.round(median(points)) : null,
    types: countBy(PAPER_TYPES, all.map((q) => q.type)),
    difficulty: countBy(PAPER_DIFFICULTIES, all.map((q) => q.difficulty)),
    // One question from the middle of each paper, three papers at most: the first lines of a paper are often the easiest.
    examples: papers.slice(0, 3).map(({ paper }) => {
      const question = paper.questions[paper.questions.length >> 1]!;
      return question.text.slice(0, 280);
    }),
  };
}

/** Smooth weighted round robin: `total` keys in proportion to the weights, spread evenly, the same every time. */
function spread<T extends string>(weights: Record<T, number>, total: number): T[] {
  const keys = (Object.keys(weights) as T[]).filter((key) => weights[key] > 0);
  const sum = keys.reduce((n, key) => n + weights[key], 0);
  if (!sum) return [];
  const current = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  return Array.from({ length: total }, () => {
    for (const key of keys) current[key] += weights[key];
    const pick = keys.reduce((best, key) => (current[key] > current[best] ? key : best));
    current[pick] -= sum;
    return pick;
  });
}

export type Slot = { type: PaperType; difficulty: PaperDifficulty };

/** The type and difficulty of each of `total` questions, in the proportions of the past papers. */
export function styleSlots(style: PastStyle, total: number): Slot[] {
  const types = spread(style.types, total);
  const levels = spread(style.difficulty, total);
  return types.map((type, i) => ({ type, difficulty: levels[i % levels.length]! }));
}

function textOf(db: Database.Database, sourceId: string): string {
  const rows = db
    .prepare(
      `SELECT text FROM passages WHERE source_id = ? AND version = (SELECT MAX(version) FROM passages WHERE source_id = ?) ORDER BY rowid`,
    )
    .all(sourceId, sourceId) as Array<{ text: string }>;
  return rows.map((row) => row.text).join("\n\n");
}

/**
 * Attaches the files of one past paper to a plan and queues the job that reads its questions. Several files (photos of
 * the pages) make one paper, read in the order given. The plan keeps the first file's row for the result.
 */
export function addPastPaper(
  db: Database.Database,
  runner: Runner,
  planId: string,
  sourceIds: string[],
): { jobId: string; sourceId: string } {
  const ids = [...new Set(sourceIds)];
  if (!ids.length || ids.length > PAPER_MAX_FILES)
    throw new IpcError("paper-files", "pastPapers.addFailed");
  // A missing engine must stop the request before any row is written.
  const selection = selectionFor(db, "lesson");
  const [lead, ...parts] = ids as [string, ...string[]];
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId))
      throw new IpcError("plan-missing", "errors.notAvailable");
    for (const id of ids) {
      // A file that is still being imported is fine: the job waits for its text.
      const source = db.prepare("SELECT status FROM sources WHERE id = ?").get(id) as
        | { status: string }
        | undefined;
      if (!source || source.status === "removed" || source.status === "failed")
        throw new IpcError("source-missing", "sources.importFailed");
      if (db.prepare("SELECT 1 FROM plan_sources WHERE plan_id = ? AND source_id = ?").get(planId, id))
        throw new IpcError("source-in-plan", "pastPapers.inPlan");
    }
    const insert = db.prepare(
      "INSERT INTO plan_sources (plan_id, source_id, role, paper_json) VALUES (?, ?, 'past_paper', ?)",
    );
    insert.run(planId, lead, null);
    for (const id of parts) insert.run(planId, id, JSON.stringify({ partOf: lead } satisfies PartOf));
  })();
  const params: ReadParams = {
    planId,
    sourceId: lead,
    partIds: parts,
    selection,
    language: planLanguage(db, planId),
  };
  return { jobId: runner.start("paper-read", params), sourceId: lead };
}

/** Import states that end on their own: the text will be there, or the import fails. */
const IMPORTING = new Set(["queued", "extracting", "indexing", "ocr-queued"]);

/** Waits until every file of the paper has its text. A scan that needs reading, or a failed import, stops the job. */
async function filesReady(db: Database.Database, files: string[], signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    const states = files.map(
      (id) =>
        (db.prepare("SELECT status FROM sources WHERE id = ?").get(id) as { status: string } | undefined)
          ?.status,
    );
    if (states.some((state) => state == null || state === "removed")) throw new Error("source-missing");
    if (states.includes("needs-ocr")) throw new Error("paper-needs-ocr");
    if (states.some((state) => state !== "ready" && !IMPORTING.has(state!))) throw new Error("source-unreadable");
    if (states.every((state) => state === "ready")) return;
    await wait(300, undefined, { signal });
  }
}

/** Takes a paper off the plan with its other files, stopping its read if it is still running. */
export function removePastPaper(
  db: Database.Database,
  runner: Runner | undefined,
  planId: string,
  sourceId: string,
): void {
  const job = readJob(db, planId, sourceId);
  if (job && (job.state === "queued" || job.state === "running")) runner?.cancel(job.id);
  const removed = db
    .prepare(
      `DELETE FROM plan_sources WHERE plan_id = ? AND role = 'past_paper' AND (source_id = ? OR json_extract(paper_json, '$.partOf') = ?)`,
    )
    .run(planId, sourceId, sourceId);
  if (!removed.changes) throw new Error("plan-source-missing");
}

export function registerPastPaperJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("paper-read", {
    jobClass: "model-cli",
    retryParams: (params) => ({
      ...(params as ReadParams),
      selection: selectionFor(db, "lesson"),
    }),
    title: (params) => {
      const row = db
        .prepare("SELECT title FROM sources WHERE id = ?")
        .get((params as ReadParams).sourceId) as { title: string } | undefined;
      return row?.title ?? null;
    },
    steps: [
      {
        // Waiting for an import holds no model slot.
        name: "wait",
        label: "jobs.paperReading",
        jobClass: null,
        async run(ctx) {
          const params = ctx.params as ReadParams;
          await filesReady(db, [params.sourceId, ...params.partIds], ctx.signal);
          return true;
        },
      },
      {
        name: "read",
        label: "jobs.paperReading",
        async run(ctx) {
          const params = ctx.params as ReadParams;
          const lead = db
            .prepare(
              "SELECT 1 FROM plan_sources WHERE plan_id = ? AND source_id = ? AND role = 'past_paper'",
            )
            .get(params.planId, params.sourceId);
          // The student took the paper off the plan before the read started.
          if (!lead) return true;
          const files = [params.sourceId, ...params.partIds];
          const text = files
            .map((id) => textOf(db, id))
            .filter(Boolean)
            .join("\n\n--- next file ---\n\n")
            .slice(0, PAPER_MAX_CHARS);
          if (!text.trim()) throw new Error("paper-no-text");
          ctx.signal.throwIfAborted();
          const result = await generate({
            run,
            signal: ctx.signal,
            selection: params.selection,
            schema: paperSchema,
            system: systemPrompt("paper.read", {
              contentLanguage: languageName(params.language),
            }),
            prompt: JSON.stringify({ files: files.length, paper: text }),
          });
          ctx.signal.throwIfAborted();
          const data = result.data as z.infer<typeof paperSchema>;
          if (!data.questions.length) throw new Error("paper-empty");
          const provenance = promptProvenance("paper.read");
          const stored: StoredPaper = {
            v: 1,
            title: data.title,
            minutes: data.minutes,
            totalPoints: data.totalPoints,
            questions: data.questions.map((question) => ({ id: uuidv7(), ...question })),
            read: {
              provider: result.provider,
              model: result.model,
              template: provenance.template,
              version: provenance.version,
              at: Date.now(),
            },
          };
          db.prepare(
            "UPDATE plan_sources SET paper_json = ? WHERE plan_id = ? AND source_id = ? AND role = 'past_paper'",
          ).run(JSON.stringify(stored), params.planId, params.sourceId);
          return true;
        },
      },
    ],
  });
}

/**
 * A practice quiz of past questions: all of one paper, or a mix of the plan's papers (at most a quiz's usual ten).
 * Each question is an open answer graded by the model against the paper's solution or the reference read with it.
 * The item is marked `pastPaper` so a plan file never carries the exam text.
 */
export function startPastPractice(db: Database.Database, planId: string, sourceId?: string) {
  const papers = readyPapers(db, planId).filter((row) => !sourceId || row.sourceId === sourceId);
  if (!papers.length) throw new Error("past-empty");
  const blocked = flaggedIds(db, "exercise");
  const buckets = papers.map(({ paper }) =>
    paper.questions.filter((question) => !questionFlagged(blocked, question)),
  );
  const questions = sourceId ? buckets[0]! : acrossTopics(buckets, QUIZ_MAX_QUESTIONS);
  if (!questions.length) throw new Error("past-empty");
  const itemId = saveQuiz(
    db,
    planId,
    questions.map((question) => ({
      id: question.id,
      stem: spaceOptions(question.text),
      grade: { kind: "open" as const, answer: "", reference: question.reference },
    })),
  );
  const provenance = promptProvenance("paper.read");
  db.prepare(
    `UPDATE items SET body_json = json_set(body_json, '$.pastPaper', 1, '$.complete', json('true')), prompt_template = ?, prompt_version = ? WHERE id = ?`,
  ).run(provenance.template, provenance.version, itemId);
  return startAttempt(db, planId, itemId);
}
