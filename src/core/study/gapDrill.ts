import type Database from "better-sqlite3";
import type { GenerateInput } from "../engine/generate";
import { runTurn } from "../engine/funnel";
import { planLanguage, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { generateQuiz, prepareQuiz, saveQuizSnapshot, type QuizSnapshot } from "./configuredQuiz";
import { gapMisses } from "./gapInsight";
import { startAttempt } from "./attempt";

const TEMPLATE = "gap.drill";
const ACTIVE = "('queued', 'running', 'interrupted')";
// Closed-form types only: the drill is graded locally and gives feedback after every question.
const drillInput = (planId: string, topicId: string) => ({
  planId,
  topicId,
  count: 10,
  feedback: true,
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

function openGap(db: Database.Database, planId: string, topicId: string) {
  return db
    .prepare(
      "SELECT id, opened_at AS openedAt FROM gaps WHERE plan_id = ? AND topic_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
    )
    .get(planId, topicId) as { id: string; openedAt: number } | undefined;
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
  const gap = openGap(db, planId, topicId);
  if (!gap || (params.gapId && params.gapId !== gap.id)) throw new Error("gap-missing");
  const input = drillInput(planId, topicId);
  const snapshot = params.snapshot ?? prepareQuiz(db, input);
  if (!params.snapshot && params.selection) snapshot.selection = params.selection;
  const misses = gapMisses(db, planId, topicId, gap.openedAt, 5);
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
  const focus = params.focus ?? JSON.stringify(
    misses.map(({ question, expected, explanation }) => ({
      question,
      expected,
      explanation,
    })),
  );
  const checkpoint = () => setParams?.({ ...params, gapId: gap.id, snapshot, focus });
  checkpoint();
  const drillSystem = systemPrompt(TEMPLATE, {
    contentLanguage: planLanguage(db, planId),
  });
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
    const itemId = saveQuizSnapshot(db, input, snapshot);
    db.prepare(
      "UPDATE items SET prompt_template = ?, prompt_version = ? WHERE id = ?",
    ).run(TEMPLATE, templateVersion(TEMPLATE), itemId);
    db.prepare("INSERT INTO gap_items (gap_id, item_id) VALUES (?, ?)").run(
      gap.id,
      itemId,
    );
    const { attemptId } = startAttempt(db, planId, itemId);
    setParams?.({ planId, topicId, gapId: gap.id, itemId, attemptId });
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

/** Latest drill for the topic that is still worth showing: running, failed, or built but not yet taken. */
export function readGapDrill(
  db: Database.Database,
  planId: string,
  topicId: string,
): { jobId: string; state: string; attemptId: string | null } | null {
  const gap = openGap(db, planId, topicId);
  if (!gap) return null;
  const row = db
    .prepare(
      `SELECT id, state, params_json FROM jobs WHERE kind = 'gap-drill'
         AND json_extract(params_json, '$.planId') = ? AND json_extract(params_json, '$.topicId') = ?
         AND (json_extract(params_json, '$.gapId') = ? OR (json_extract(params_json, '$.gapId') IS NULL AND created_at >= ?))
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(planId, topicId, gap.id, gap.openedAt) as
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
  }
  return { jobId: row.id, state: row.state, attemptId: attemptId ?? null };
}

/** Reuses a running or untaken drill instead of generating (and paying for) another. */
export function enqueueGapDrill(
  db: Database.Database,
  runner: Runner,
  input: { planId: string; topicId: string },
): { jobId: string } {
  const gap = openGap(db, input.planId, input.topicId);
  if (!gap) throw new Error("gap-missing");
  const current = readGapDrill(db, input.planId, input.topicId);
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
