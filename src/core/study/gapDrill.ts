import type Database from "better-sqlite3";
import { z } from "zod";
import { generate, type GenerateInput } from "../engine/generate";
import { runTurn } from "../engine/funnel";
import { planLanguage, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { generateQuiz, prepareQuiz, saveQuizSnapshot, type QuizSnapshot } from "./configuredQuiz";
import { gapEvidence } from "./gapInsight";
import { startAttempt } from "./attempt";

const TEMPLATE = "gap.drill";
/** A mixed review left alone this long is not resumed (LES-13); its adopted drill questions are free to be adopted again. */
export const REVIEW_SESSION_TTL = 24 * 3_600_000;
const ACTIVE = "('queued', 'running', 'interrupted')";
/** LES-03: a short explanation and five targeted questions. */
export const DRILL_QUESTIONS = 5;
// Closed-form types only: the drill is graded locally and gives feedback after every question.
const drillInput = (planId: string, topicId: string) => ({
  planId,
  topicId,
  count: DRILL_QUESTIONS,
  drill: true,
  types: ["mcq", "tf", "completion"] as Array<"mcq" | "tf" | "completion">,
});

type Params = {
  planId: string;
  topicId: string;
  gapId?: string;
  itemId?: string;
  attemptId?: string;
  selection?: ReturnType<typeof selectionFor>;
  snapshot?: QuizSnapshot;
  focus?: string;
};

const explanationSchema = z.object({ explanation: z.string().trim().min(1).max(1200) });

/**
 * The open gap a drill is for: the one asked for, or when none is named the topic's top gap (severe first, then most
 * linked wrong answers, then oldest). A gap that has closed or whose topic was archived is not open.
 */
export function openGap(db: Database.Database, planId: string, topicId: string, gapId?: string) {
  return db
    .prepare(
      `SELECT g.id, g.opened_at AS openedAt, g.misconception FROM gaps g
       JOIN topics t ON t.id = g.topic_id AND t.archived_at IS NULL
       WHERE g.plan_id = ? AND g.topic_id = ? AND g.closed_at IS NULL AND (? IS NULL OR g.id = ?)
       ORDER BY (g.severity = 'severe') DESC,
         (SELECT count(*) FROM gap_answers ga WHERE ga.gap_id = g.id) DESC, g.opened_at, g.id LIMIT 1`,
    )
    .get(planId, topicId, gapId ?? null, gapId ?? null) as
    | { id: string; openedAt: number; misconception: string | null }
    | undefined;
}

/**
 * The open gap a gap's work now belongs to. A gap that merged into another (PRO-02: the same idea) hands its drill and
 * answers to the survivor, so a drill built for it is not lost. A gap that closed by learning has no successor.
 */
function successor(db: Database.Database, gapId: string): string | undefined {
  let id: string | null = gapId;
  for (let hops = 0; id && hops < 32; hops++) {
    const row = db.prepare("SELECT closed_at, merged_into FROM gaps WHERE id = ?").get(id) as
      | { closed_at: number | null; merged_into: string | null }
      | undefined;
    if (!row) return undefined;
    if (row.closed_at == null) return id;
    id = row.merged_into;
  }
  return undefined;
}

/** Builds a quiz of new questions aimed at what the student got wrong; it grades like any topic quiz. */
export async function buildGapDrill(
  db: Database.Database,
  params: Params,
  run: GenerateInput["run"] = runTurn,
  signal?: AbortSignal,
  setParams?: (params: Params) => void,
): Promise<string> {
  if (params.attemptId) return params.attemptId;
  const { planId, topicId } = params;
  const gap = openGap(db, planId, topicId, params.gapId);
  if (!gap) throw new Error("gap-missing");
  const input = drillInput(planId, topicId);
  const snapshot = params.snapshot ?? prepareQuiz(db, input);
  if (!params.snapshot && params.selection) snapshot.selection = params.selection;
  const misses = gapEvidence(db, gap.id, 5);
  const cited = [...new Set(misses.flatMap((miss) => miss.passageIds))];
  if (!params.snapshot && cited.length) {
    const rows = db
      .prepare(
        `SELECT p.id, p.text FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
         WHERE tp.topic_id = ? AND p.id IN (${cited.map(() => "?").join(",")})`,
      )
      .all(topicId, ...cited) as Array<{ id: string; text: string }>;
    const ids = new Set(rows.map((row) => row.id));
    snapshot.passages = [
      ...rows.map((row) => ({ id: row.id, text: row.text.slice(0, 1000) })),
      ...snapshot.passages.filter((row) => !ids.has(row.id)),
    ].slice(0, 12);
  }
  // What the student misunderstands, and the wrong answers behind it, in full: the drill aims at the idea, not the wording.
  const focus =
    params.focus ??
    JSON.stringify({
      misconception: gap.misconception,
      mistakes: misses.map(({ question, answer, expected, explanation }) => ({
        question,
        studentAnswer: answer,
        expected,
        explanation,
      })),
    });
  const checkpoint = () => setParams?.({ ...params, gapId: gap.id, snapshot, focus });
  checkpoint();
  const contentLanguage = planLanguage(db, planId);
  if (!snapshot.explanation) {
    const written = await generate({
      selection: snapshot.selection,
      run,
      signal,
      schema: explanationSchema,
      system: systemPrompt("gap.explain", { contentLanguage }),
      prompt: JSON.stringify({
        topic: (db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(topicId) as string | undefined) ?? "",
        focus: JSON.parse(focus),
        passages: snapshot.passages.slice(0, 6).map((row) => row.text),
      }),
    });
    snapshot.explanation = (written.data as z.infer<typeof explanationSchema>).explanation;
    checkpoint();
  }
  const drillSystem = systemPrompt(TEMPLATE, { contentLanguage });
  // The quiz builder owns the batch loop; the drill only adds its focus to the system text.
  await generateQuiz(
    snapshot,
    (turn) =>
      run({
        ...turn,
        system: `${turn.system ?? ""}\n\n${drillSystem}\nFocus data: ${focus}`,
      }),
    signal,
    checkpoint,
  );
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return db.transaction(() => {
    // The gap may have closed while the model wrote; its drill is then not wanted. If it merged into another gap, the
    // drill is that gap's now: the two were judged the same misconception.
    const target = successor(db, gap.id);
    if (!target || !openGap(db, planId, topicId, target)) throw new Error("gap-missing");
    const itemId = saveQuizSnapshot(db, input, snapshot);
    db.prepare(
      "UPDATE items SET prompt_template = ?, prompt_version = ? WHERE id = ?",
    ).run(TEMPLATE, templateVersion(TEMPLATE), itemId);
    db.prepare("INSERT INTO gap_items (gap_id, item_id) VALUES (?, ?)").run(
      target,
      itemId,
    );
    const { attemptId } = startAttempt(db, planId, itemId);
    setParams?.({ planId, topicId, gapId: target, itemId, attemptId });
    return attemptId;
  })();
}

export function registerGapJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("gap-drill", {
    jobClass: "model-cli",
    retryParams: (raw) => {
      const params = raw as Params;
      const selection = selectionFor(db, "lesson");
      return { ...params, selection, ...(params.snapshot ? { snapshot: { ...params.snapshot, selection } } : {}) };
    },
    steps: [
      {
        name: "questions",
        label: "jobs.gapDrill",
        async run(ctx) {
          await buildGapDrill(
            db,
            ctx.params as Params,
            run,
            ctx.signal,
            ctx.setParams,
          );
          return true;
        },
      },
    ],
  });
}

/**
 * Drill jobs whose questions now live in a live mixed review. Their separate quiz is hidden, so
 * a drill is taken once; a discarded or expired review gives its drill back.
 */
function adoptedJobs(db: Database.Database, planId: string, now: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT i.created_at, i.body_json,
         (SELECT a.submitted_at FROM attempts a
          WHERE a.id = json_extract(i.body_json, '$.attemptId')) AS submitted_at
       FROM items i WHERE i.plan_id = ? AND i.kind = 'review_session'
         AND json_extract(i.body_json, '$.discardedAt') IS NULL`,
    )
    .all(planId) as Array<{ created_at: number; body_json: string; submitted_at: number | null }>;
  const jobs = new Set<string>();
  for (const row of rows) {
    if (row.submitted_at == null && now - row.created_at > REVIEW_SESSION_TTL) continue;
    const { drills = [] } = JSON.parse(row.body_json) as {
      drills?: Array<{ jobId?: string; adopted?: boolean }>;
    };
    for (const drill of drills) if (drill.adopted && drill.jobId) jobs.add(drill.jobId);
  }
  return jobs;
}

/** Latest drill for the topic that is still worth showing: running, failed, or built but not yet taken. */
export function readGapDrill(
  db: Database.Database,
  planId: string,
  topicId: string,
  gapId?: string,
  now = Date.now(),
): { jobId: string; state: string; attemptId: string | null } | null {
  const gap = openGap(db, planId, topicId, gapId);
  if (!gap) return null;
  // The gap itself and every gap that merged into it: their drills are this gap's drills.
  const row = db
    .prepare(
      `WITH RECURSIVE merged(id) AS (
         SELECT ? UNION SELECT g.id FROM gaps g JOIN merged m ON g.merged_into = m.id)
       SELECT id, state, params_json FROM jobs WHERE kind = 'gap-drill'
         AND json_extract(params_json, '$.planId') = ? AND json_extract(params_json, '$.topicId') = ?
         AND (json_extract(params_json, '$.gapId') IN (SELECT id FROM merged)
              OR (json_extract(params_json, '$.gapId') IS NULL AND created_at >= ?))
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(gap.id, planId, topicId, gap.openedAt) as
    | { id: string; state: string; params_json: string }
    | undefined;
  if (!row) return null;
  const { attemptId } = JSON.parse(row.params_json) as Params;
  if (row.state === "succeeded") {
    const attempt = attemptId
      ? (db
          .prepare("SELECT submitted_at FROM attempts WHERE id = ? AND plan_id = ?")
          .get(attemptId, planId) as { submitted_at: number | null } | undefined)
      : undefined;
    if (!attempt || attempt.submitted_at != null) return null;
    if (adoptedJobs(db, planId, now).has(row.id)) return null;
  }
  return { jobId: row.id, state: row.state, attemptId: attemptId ?? null };
}

/** Reuses a running or untaken drill instead of generating (and paying for) another. */
export function enqueueGapDrill(
  db: Database.Database,
  runner: Runner,
  input: { planId: string; topicId: string; gapId?: string },
): { jobId: string } {
  const gap = openGap(db, input.planId, input.topicId, input.gapId);
  if (!gap) throw new Error("gap-missing");
  const current = readGapDrill(db, input.planId, input.topicId, gap.id);
  if (
    current &&
    (current.state === "succeeded" ||
      db
        .prepare(`SELECT 1 FROM jobs WHERE id = ? AND state IN ${ACTIVE}`)
        .get(current.jobId))
  )
    return { jobId: current.jobId };
  return {
    jobId: runner.start("gap-drill", {
      planId: input.planId,
      topicId: input.topicId,
      selection: selectionFor(db, "lesson"),
      gapId: gap.id,
    } satisfies Params),
  };
}
