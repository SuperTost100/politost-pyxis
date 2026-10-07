import type Database from "better-sqlite3";
import { interestsLine } from "../profile/context";
import { uuidv7 } from "../../shared/ids";
import { syncGaps } from "../plans/progress";
import { enqueueGapInsights } from "./gapInsight";
import { z } from "zod";
import { generate, type GenerateInput } from "../engine/generate";
import {
  languageName,
  planLanguage,
  promptProvenance,
  systemPrompt,
  templateVersion,
} from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { recordStep, stepResult } from "../plans/steps";
import { topicExercises } from "./exercises";
import { acrossTopics } from "./topicQuiz";

type Stored = {
  minutes: number;
  picks?: Record<string, string>;
  gradingStartedAt?: number;
  gradingJobId?: string;
  result?: { score: number; results: SimulationGrade[] };
  /** Set when the model wrote the questions from topic passages, not the book's exam exercises. */
  generated?: { provider: string; model: string };
  /** The prepared build this attempt was started from, so one build starts one exam. */
  buildJobId?: string;
  questions: Array<{
    id: string;
    sourceId?: string;
    topicId?: string;
    passageIds?: string[];
    stem: string;
    answer: { kind: "completion"; accepted: string[][] };
  }>;
};

function topicScores(
  db: Database.Database,
  stored: Stored,
  attemptId: string,
  submitted: boolean,
) {
  if (!submitted) return [];
  const answer = db
    .prepare(
      `SELECT payload_json FROM attempt_answers WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(attemptId) as { payload_json: string } | undefined;
  if (!answer) return [];
  const payload = JSON.parse(answer.payload_json) as {
    results?: Array<{ id: string; score: number }>;
  };
  const scores = new Map(
    (payload.results ?? []).map((row) => [row.id, row.score]),
  );
  const byTopic = new Map<string, number[]>();
  for (const question of stored.questions) {
    if (!question.topicId) continue;
    const list = byTopic.get(question.topicId) ?? [];
    list.push(scores.get(question.id) ?? 0);
    byTopic.set(question.topicId, list);
  }
  return [...byTopic].map(([id, list]) => {
    const title = db
      .prepare(`SELECT title FROM topics WHERE id = ?`)
      .get(id) as { title: string } | undefined;
    return {
      id,
      title: title?.title ?? id,
      score: list.reduce((sum, score) => sum + score, 0) / list.length,
    };
  });
}

function smartbookQuestions(
  db: Database.Database,
  planId: string,
  source: "exam" | "mixed",
): Stored["questions"] {
  const topics = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position`)
    .all(planId) as Array<{ id: string }>;
  return acrossTopics(
    topics.map((topic) =>
      topicExercises(db, topic.id)
        .filter((row) => row.answer && row.answer.trim())
        .filter((row) => source === "mixed" || row.kind === "esame")
        .map((row) => ({
          id: uuidv7(),
          sourceId: row.id,
          topicId: topic.id,
          stem: row.prompt,
          answer: {
            kind: "completion" as const,
            accepted: [[row.answer ?? ""]],
          },
        })),
    ),
    20,
  );
}

function insertAttempt(
  db: Database.Database,
  planId: string,
  body: Stored,
  now: number,
  passageIds: string[] = [],
) {
  const itemId = uuidv7(now);
  const attemptId = uuidv7(now + 1);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, grounding, engine_provider, model_id, model_source, prompt_template, prompt_version, created_at)
       VALUES (?, ?, 'simulation', ?, 'sources', ?, ?, ?, ?, ?, ?)`,
    ).run(
      itemId,
      planId,
      JSON.stringify(body),
      body.generated?.provider ?? null,
      body.generated?.model ?? null,
      body.generated ? "reported" : null,
      body.generated ? "simulation.questions" : null,
      body.generated ? templateVersion("simulation.questions") : null,
      now,
    );
    for (const passageId of passageIds)
      db.prepare(
        "INSERT OR IGNORE INTO item_passages (item_id, passage_id) VALUES (?, ?)",
      ).run(itemId, passageId);
    db.prepare(
      `INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES (?, ?, ?, ?)`,
    ).run(attemptId, planId, itemId, now);
  })();
  return {
    attemptId,
    deadline: now + body.minutes * 60_000,
    questions: body.questions.map((question) => ({
      id: question.id,
      stem: question.stem,
    })),
  };
}

function topicPassages(db: Database.Database, planId: string) {
  const topics = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position`)
    .all(planId) as Array<{ id: string }>;
  return topics
    .map((topic) => ({
      topicId: topic.id,
      passages: db
        .prepare(
          `SELECT p.id, p.text FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ? ORDER BY p.created_at, p.id`,
        )
        .all(topic.id) as Array<{ id: string; text: string }>,
    }))
    .filter((topic) => topic.passages.length > 0);
}

/**
 * Starts the exam now: from a model-written build that is ready and has not been
 * started, otherwise from smartbook exercises. The clock starts here, never when a build finishes.
 */
export function startSimulation(
  db: Database.Database,
  planId: string,
  minutes?: number,
  now = Date.now(),
  source: "exam" | "mixed" = "mixed",
) {
  selectionFor(db, "grading");
  // A prepared exam is what the screen offered, so it wins over book exercises added since. The questions do not depend on
  // the length, so the length asked for at Start is the one the clock uses; with none given, the prepared one stands.
  const ready = readyBuild(db, planId);
  if (ready)
    return insertAttempt(
      db,
      planId,
      {
        minutes: minutes ?? ready.params.minutes,
        questions: ready.params.questions,
        generated: {
          provider: ready.params.provider ?? "",
          model: ready.params.model ?? "",
        },
        buildJobId: ready.jobId,
      },
      now,
      [...new Set(ready.params.questions.flatMap((q) => q.passageIds ?? []))],
    );
  const questions = smartbookQuestions(db, planId, source);
  if (questions.length > 0)
    return insertAttempt(db, planId, { minutes: minutes ?? 30, questions }, now);
  throw new Error(
    topicPassages(db, planId).length
      ? "simulation-needs-build"
      : "simulation-empty",
  );
}

type BuildParams = {
  planId: string;
  minutes: number;
  /** Chosen at start so a later engine change cannot alter a running build. */
  selection: StoredSelection;
  language: string;
  /** PER-04 line captured at start, so a retry writes the same kind of problems. */
  interests?: string;
  batches: Array<{
    topicId: string;
    count: number;
    passages: Array<{ id: string; text: string }>;
  }>;
  next: number;
  questions: Stored["questions"];
  provider?: string;
  model?: string;
  /** Older builds started their own attempt; newer ones leave the exam ready until Start. */
  attemptId?: string;
};
const questionsSchema = (count: number) =>
  z.object({
    questions: z
      .array(
        z.object({
          stem: z.string().trim().min(1).max(5000),
          reference: z.string().trim().min(1).max(5000),
          passageIds: z.array(z.string()).min(1).max(8),
        }),
      )
      .length(count),
  });
const BUILD_QUESTIONS = 20;
const BUILD_TOPICS = BUILD_QUESTIONS;

function buildBatches(db: Database.Database, planId: string) {
  const all = topicPassages(db, planId);
  const topicCount = Math.min(BUILD_TOPICS, all.length);
  const spread = Array.from(
    { length: topicCount },
    (_, i) =>
      all[Math.floor((i * (all.length - 1)) / Math.max(1, topicCount - 1))]!,
  );
  return spread.map((topic, i) => ({
    topicId: topic.topicId,
    count:
      Math.floor(BUILD_QUESTIONS / spread.length) +
      (i < BUILD_QUESTIONS % spread.length ? 1 : 0),
    passages: topic.passages
      .filter(
        (_, j) => j % Math.max(1, Math.ceil(topic.passages.length / 8)) === 0,
      )
      .slice(0, 8)
      .map((row) => ({ id: row.id, text: row.text.slice(0, 1000) })),
  }));
}

/**
 * Starts the attempt at once from smartbook exercises, or queues a cancellable,
 * retryable job that has the model write questions from topic passages. A finished
 * build is returned as it is; the student starts it with startSimulation.
 */
export function enqueueSimulation(
  db: Database.Database,
  planId: string,
  minutes = 30,
  now = Date.now(),
  source: "exam" | "mixed" = "exam",
): { attemptId: string } | { jobId: string } {
  const runner = runtimes.get(db);
  if (!runner) throw new Error("simulation-grading-unavailable");
  selectionFor(db, "grading");
  if (smartbookQuestions(db, planId, source).length)
    return {
      attemptId: startSimulation(db, planId, minutes, now, source).attemptId,
    };
  const ready = readyBuild(db, planId);
  if (ready) {
    // The prepared questions stand; the length is only a time budget, so the latest request is the one that applies.
    if (ready.params.minutes !== minutes)
      db.prepare("UPDATE jobs SET params_json = json_set(params_json, '$.minutes', ?) WHERE id = ?").run(
        minutes,
        ready.jobId,
      );
    return { jobId: ready.jobId };
  }
  const batches = buildBatches(db, planId);
  if (!batches.length) throw new Error("simulation-empty");
  const running = buildJob(db, planId);
  if (running && ["queued", "running", "interrupted"].includes(running.state)) {
    if (running.state === "interrupted") runner.resume(running.jobId);
    return { jobId: running.jobId };
  }
  const params: BuildParams = {
    planId,
    minutes,
    selection: selectionFor(db, "lesson"),
    language: planLanguage(db, planId),
    interests: interestsLine(db) || undefined,
    batches,
    next: 0,
    questions: [],
  };
  return { jobId: runner.start("simulation-build", params) };
}

function buildJob(db: Database.Database, planId: string) {
  const job = db
    .prepare(
      "SELECT id AS jobId, state, error, params_json FROM jobs WHERE kind='simulation-build' AND json_extract(params_json,'$.planId')=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(planId) as
    | {
        jobId: string;
        state: string;
        error: string | null;
        params_json: string;
      }
    | undefined;
  return job
    ? { ...job, params: JSON.parse(job.params_json) as BuildParams }
    : undefined;
}

/**
 * Whether a prepared exam still matches the plan: each question's topic is active and still holds the passages it cites.
 * A rebuild that archived a topic, or re-extracted a source so its passages changed, leaves the old questions behind.
 */
function buildCurrent(db: Database.Database, planId: string, questions: Stored["questions"]): boolean {
  const holds = db.prepare(
    `SELECT 1 FROM topic_passages tp JOIN topics t ON t.id = tp.topic_id
     WHERE tp.topic_id = ? AND tp.passage_id = ? AND t.plan_id = ? AND t.archived_at IS NULL`,
  );
  const live = db.prepare("SELECT 1 FROM topics WHERE id = ? AND plan_id = ? AND archived_at IS NULL");
  return questions.every(
    (question) =>
      !question.topicId ||
      (live.get(question.topicId, planId) != null &&
        (question.passageIds ?? []).every((id) => holds.get(question.topicId, id, planId) != null)),
  );
}

/** The latest build whose questions are done, are still current, and which no attempt has started from. */
function readyBuild(db: Database.Database, planId: string) {
  const job = buildJob(db, planId);
  if (
    !job ||
    job.state !== "succeeded" ||
    job.params.attemptId ||
    !job.params.questions.length
  )
    return undefined;
  const started = db
    .prepare(
      "SELECT 1 FROM items WHERE plan_id=? AND kind='simulation' AND json_extract(body_json,'$.buildJobId')=?",
    )
    .get(planId, job.jobId);
  if (started || !buildCurrent(db, planId, job.params.questions)) return undefined;
  return job;
}

/**
 * Latest question build that has not been started as an exam. State "succeeded"
 * means the exam is prepared and waiting for an explicit start; null once started.
 */
export function readSimulationBuild(db: Database.Database, planId: string) {
  const job = buildJob(db, planId);
  if (!job || job.params.attemptId) return null;
  if (job.state === "succeeded" && !readyBuild(db, planId)) return null;
  return {
    jobId: job.jobId,
    state: job.state,
    error: job.error,
    progress: job.params.next / Math.max(1, job.params.batches.length),
    minutes: job.params.minutes,
    provider: job.params.provider,
    model: job.params.model,
  };
}

export type SimulationGrade = {
  id: string;
  score: number;
  expected: string;
  feedback: string;
  missed: string[];
  provider: string;
  model: string;
  prompt?: { template: string; version: string };
};
type GradeParams = {
  attemptId: string;
  planId: string;
  itemId: string;
  picks: Record<string, string>;
  questions: Stored["questions"];
  selection: StoredSelection;
  language: string;
  next: number;
  results: SimulationGrade[];
  frozenAt: number;
};
const runtimes = new WeakMap<Database.Database, Runner>();
const gradingSchema = z.object({
  score: z.number().min(0).max(1),
  feedback: z.string().trim().min(1).max(4000),
  missed: z.array(z.string().trim().min(1).max(500)).max(20),
});
function simulationRow(db: Database.Database, attemptId: string) {
  const row = db
    .prepare(
      "SELECT a.started_at,a.submitted_at,a.plan_id,i.id AS item_id,i.body_json FROM attempts a JOIN items i ON i.id=a.item_id WHERE a.id=? AND i.kind='simulation'",
    )
    .get(attemptId) as
    | {
        started_at: number;
        submitted_at: number | null;
        plan_id: string;
        item_id: string;
        body_json: string;
      }
    | undefined;
  if (!row) throw new Error("simulation-missing");
  return { ...row, body: JSON.parse(row.body_json) as Stored };
}
export function registerSimulationJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runtimes.set(db, runner);
  runner.register("simulation-build", {
    retryParams: (params) => ({
      ...(params as BuildParams),
      selection: selectionFor(db, "lesson"),
    }),
    jobClass: "model-cli",
    steps: [
      {
        name: "questions",
        label: "simulation.building",
        async run(ctx) {
          const params = ctx.params as BuildParams;
          while (params.next < params.batches.length) {
            ctx.signal.throwIfAborted();
            const batch = params.batches[params.next]!;
            const known = new Set(batch.passages.map((row) => row.id));
            const schema = questionsSchema(batch.count).superRefine(
              (data, issue) => {
                const seen = new Set(
                  params.questions.map((q) => q.stem.trim().toLowerCase()),
                );
                data.questions.forEach((question, i) => {
                  const key = question.stem.trim().toLowerCase();
                  if (
                    seen.has(key) ||
                    question.passageIds.some((id) => !known.has(id))
                  )
                    issue.addIssue({
                      code: "custom",
                      message: "Repeated question or unknown passage ID",
                      path: ["questions", i],
                    });
                  seen.add(key);
                });
              },
            );
            const result = await generate({
              run,
              signal: ctx.signal,
              selection: params.selection,
              schema,
              system: [
                systemPrompt("simulation.questions", {
                  contentLanguage: languageName(params.language),
                }),
                params.interests,
              ]
                .filter(Boolean)
                .join("\n"),
              prompt: JSON.stringify({
                count: batch.count,
                passages: batch.passages,
                previousQuestions: params.questions.map((q) => q.stem),
              }),
            });
            ctx.signal.throwIfAborted();
            for (const row of (result.data as z.infer<typeof schema>).questions)
              params.questions.push({
                id: uuidv7(),
                topicId: batch.topicId,
                passageIds: row.passageIds,
                stem: row.stem,
                answer: { kind: "completion", accepted: [[row.reference]] },
              });
            params.provider = result.provider;
            params.model = result.model;
            params.next++;
            ctx.setParams(params);
          }
          ctx.signal.throwIfAborted();
          // The exam stays prepared in these params; startSimulation creates the attempt and starts the clock.
          return true;
        },
      },
    ],
  });
  runner.register("simulation-grade", {
    retryParams: (params) => ({
      ...(params as GradeParams),
      selection: selectionFor(db, "grading"),
    }),
    jobClass: "model-cli",
    steps: [
      {
        name: "grading",
        label: "jobs.simulationGrading",
        async run(ctx) {
          const params = ctx.params as GradeParams;
          while (params.next < params.questions.length) {
            ctx.signal.throwIfAborted();
            const question = params.questions[params.next]!;
            const expected = question.answer.accepted[0]?.[0] ?? "";
            const answer = (params.picks[question.id] ?? "").trim();
            const result = answer
              ? await generate({
                  run,
                  signal: ctx.signal,
                  selection: params.selection,
                  schema: gradingSchema,
                  system: systemPrompt("simulation.grade", {
                    contentLanguage: languageName(params.language),
                  }),
                  prompt: JSON.stringify({
                    question: question.stem,
                    reference: expected,
                    answer: params.picks[question.id] ?? "",
                  }),
                })
              : undefined;
            ctx.signal.throwIfAborted();
            const data = result?.data as
              z.infer<typeof gradingSchema> | undefined;
            const grade: SimulationGrade = {
              id: question.id,
              score: data?.score ?? 0,
              expected,
              feedback:
                data?.feedback ??
                (languageName(params.language) === "Italian"
                  ? "Nessuna risposta."
                  : "No answer."),
              missed: data?.missed ?? [],
              provider: result?.provider ?? "",
              model: result?.model ?? "",
              prompt: result ? promptProvenance("simulation.grade") : undefined,
            };
            db.transaction(() => {
              simulationRow(db, params.attemptId);
              params.results.push(grade);
              params.next++;
              ctx.setParams(params);
            })();
          }
          ctx.signal.throwIfAborted();
          db.transaction(() => {
            const row = simulationRow(db, params.attemptId);
            if (row.submitted_at != null) return;
            const score =
              params.results.reduce((n, r) => n + r.score, 0) /
              Math.max(1, params.results.length);
            const now = Date.now();
            row.body.result = { score, results: params.results };
            const prompt = promptProvenance("simulation.grade");
            // Model-written questions keep their own provenance on the item; grading lives in each result.
            if (row.body.generated)
              db.prepare("UPDATE items SET body_json=? WHERE id=?").run(
                JSON.stringify(row.body),
                row.item_id,
              );
            else
              db.prepare(
                "UPDATE items SET body_json=?, prompt_template=?, prompt_version=? WHERE id=?",
              ).run(
                JSON.stringify(row.body),
                prompt.template,
                prompt.version,
                row.item_id,
              );
            db.prepare(
              "INSERT INTO attempt_answers (id,attempt_id,payload_json,created_at) VALUES(?,?,?,?)",
            ).run(
              uuidv7(now),
              params.attemptId,
              JSON.stringify({
                picks: params.picks,
                score,
                results: params.results.map((r) => ({
                  ...r,
                  explanation: r.feedback,
                })),
              }),
              now,
            );
            db.prepare(
              "UPDATE attempts SET submitted_at=? WHERE id=? AND submitted_at IS NULL",
            ).run(params.frozenAt, params.attemptId);
            recordTopicScores(
              db,
              params.planId,
              params.questions,
              params.results,
              now,
              "simulation",
              params.attemptId,
            );
            recordStep(
              db,
              params.planId,
              { activity: "simulation", result: stepResult(params.results) },
              now + params.results.length + 1,
            );
            syncGaps(db, params.planId, now);
          })();
          enqueueGapInsights(db, runner, params.attemptId);
          return true;
        },
      },
    ],
  });
}
function freezeSimulation(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string> | undefined,
  now: number,
  retry = false,
) {
  const runner = runtimes.get(db);
  if (!runner) throw new Error("simulation-grading-unavailable");
  db.transaction(() => {
    const row = simulationRow(db, attemptId);
    if (row.submitted_at != null) return;
    if (row.body.gradingJobId) {
      if (retry) {
        const job = db
          .prepare("SELECT state FROM jobs WHERE id=?")
          .get(row.body.gradingJobId) as { state: string } | undefined;
        if (job?.state === "interrupted") runner.resume(row.body.gradingJobId);
        else if (job?.state === "failed" || job?.state === "cancelled")
          runner.retry(row.body.gradingJobId);
      }
      return;
    }
    const expired = now >= row.started_at + row.body.minutes * 60000;
    row.body.picks = Object.fromEntries(
      row.body.questions.map((q) => [
        q.id,
        (expired
          ? row.body.picks?.[q.id]
          : (picks?.[q.id] ?? row.body.picks?.[q.id])) ?? "",
      ]),
    );
    row.body.gradingStartedAt = Math.min(
      now,
      row.started_at + row.body.minutes * 60000,
    );
    const language = planLanguage(db, row.plan_id);
    const params: GradeParams = {
      attemptId,
      planId: row.plan_id,
      itemId: row.item_id,
      picks: row.body.picks,
      questions: row.body.questions,
      selection: selectionFor(db, "grading"),
      language,
      next: 0,
      results: [],
      frozenAt: row.body.gradingStartedAt,
    };
    row.body.gradingJobId = runner.start("simulation-grade", params);
    db.prepare("UPDATE items SET body_json=? WHERE id=?").run(
      JSON.stringify(row.body),
      row.item_id,
    );
  })();
}
/**
 * The exam whose answers are still open, if any. Once answers are frozen the tutor
 * unlocks, even while grading runs or has failed. Chat checks this before answering.
 */
export function activeSimulation(db: Database.Database) {
  return (
    (db
      .prepare(
        "SELECT a.id AS attemptId, a.plan_id AS planId FROM attempts a JOIN items i ON i.id=a.item_id WHERE i.kind='simulation' AND a.submitted_at IS NULL AND json_extract(i.body_json,'$.gradingStartedAt') IS NULL ORDER BY a.started_at DESC LIMIT 1",
      )
      .get() as { attemptId: string; planId: string } | undefined) ?? null
  );
}
export function readSimulation(
  db: Database.Database,
  attemptId: string,
  now = Date.now(),
) {
  let row = simulationRow(db, attemptId);
  const deadline = row.started_at + row.body.minutes * 60000;
  let blocked: string | undefined;
  if (row.submitted_at == null && now >= deadline && !row.body.gradingJobId) {
    // A missing engine must not make the exam unreadable; the page offers settings and a retry.
    try {
      freezeSimulation(db, attemptId, undefined, now);
      row = simulationRow(db, attemptId);
    } catch (err) {
      blocked = err instanceof Error ? err.message : "failed";
    }
  }
  const job = row.body.gradingJobId
    ? (db
        .prepare(
          "SELECT id AS jobId,state,error,params_json FROM jobs WHERE id=?",
        )
        .get(row.body.gradingJobId) as
        | {
            jobId: string;
            state: string;
            error: string | null;
            params_json: string;
          }
        | undefined)
    : undefined;
  const params = job ? (JSON.parse(job.params_json) as GradeParams) : undefined;
  const grading = job
    ? {
        jobId: job.jobId,
        state: job.state,
        error: job.error,
        progress:
          (params?.next ?? 0) / Math.max(1, params?.questions.length ?? 0),
        provider: params?.results.at(-1)?.provider,
        model: params?.results.at(-1)?.model,
      }
    : undefined;
  return {
    attemptId,
    planId: row.plan_id,
    deadline,
    leftMs:
      row.submitted_at != null || row.body.gradingStartedAt != null
        ? 0
        : Math.max(0, deadline - now),
    submitted: row.submitted_at != null,
    locked:
      row.submitted_at != null ||
      row.body.gradingStartedAt != null ||
      now >= deadline,
    blocked,
    generated: row.body.generated,
    questions: row.body.questions.map((q) => ({ id: q.id, stem: q.stem })),
    picks: row.body.picks ?? {},
    topics: topicScores(db, row.body, attemptId, row.submitted_at != null),
    grading,
    score: row.body.result?.score,
    results: row.submitted_at != null ? row.body.result?.results : undefined,
  };
}
export function submitSimulation(
  db: Database.Database,
  attemptId: string,
  picks?: Record<string, string>,
  now = Date.now(),
) {
  freezeSimulation(db, attemptId, picks, now, true);
  return readSimulation(db, attemptId, now);
}
export function saveSimulationDraft(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, string>,
) {
  const row = simulationRow(db, attemptId);
  if (
    row.submitted_at == null &&
    row.body.gradingStartedAt == null &&
    Date.now() < row.started_at + row.body.minutes * 60000
  ) {
    row.body.picks = Object.fromEntries(
      row.body.questions.map((q) => [q.id, picks[q.id] ?? ""]),
    );
    db.prepare("UPDATE items SET body_json=? WHERE id=?").run(
      JSON.stringify(row.body),
      row.item_id,
    );
  }
  return readSimulation(db, attemptId);
}

export function recordTopicScores(
  db: Database.Database,
  planId: string,
  questions: Array<{
    topicId?: string;
    id?: string;
    answer?: { kind: string };
  }>,
  results: Array<{ score: number }>,
  now: number,
  evidenceKind: "simulation" | "quiz" = "simulation",
  attemptId?: string,
): void {
  const byTopic = new Map<
    string,
    Array<{ id?: string; kind?: string; score: number }>
  >();
  questions.forEach((question, index) => {
    const topicId = question.topicId;
    const score = results[index]?.score;
    if (!topicId || score == null) return;
    const list = byTopic.get(topicId) ?? [];
    list.push({ id: question.id, kind: question.answer?.kind, score });
    byTopic.set(topicId, list);
  });
  let at = now;
  for (const [topicId, questionScores] of byTopic) {
    const scores = questionScores.map((answer) => answer.score);
    const score = scores.reduce((sum, item) => sum + item, 0) / scores.length;
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    ).run(
      uuidv7(at),
      planId,
      topicId,
      JSON.stringify({ score, scores, evidenceKind, questionScores, attemptId }),
      at,
    );
    at += 1;
  }
}

export function openSimulation(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  const row = db
    .prepare(
      `SELECT a.id FROM attempts a
       JOIN items i ON i.id = a.item_id
       WHERE a.plan_id = ? AND i.kind = 'simulation' AND a.submitted_at IS NULL
       ORDER BY a.started_at DESC LIMIT 1`,
    )
    .get(planId) as { id: string } | undefined;
  if (!row) return null;
  return readSimulation(db, row.id, now);
}

export function listSimulations(db: Database.Database, planId: string) {
  const rows = db
    .prepare(
      `SELECT a.id, a.started_at, a.submitted_at
       FROM attempts a
       JOIN items i ON i.id = a.item_id
       WHERE a.plan_id = ? AND i.kind = 'simulation' AND a.submitted_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM attempt_answers aa WHERE aa.attempt_id = a.id)
       ORDER BY a.submitted_at DESC`,
    )
    .all(planId) as Array<{
    id: string;
    started_at: number;
    submitted_at: number;
  }>;
  return rows.map((row) => {
    const answer = db
      .prepare(
        `SELECT payload_json FROM attempt_answers WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as { payload_json: string } | undefined;
    const payload = answer
      ? (JSON.parse(answer.payload_json) as {
          results?: Array<{ score: number }>;
        })
      : {};
    const scores = (payload.results ?? []).map((item) => item.score);
    const score =
      scores.length === 0
        ? 0
        : scores.reduce((sum, item) => sum + item, 0) / scores.length;
    return {
      id: row.id,
      at: row.submitted_at,
      score,
      minutes: Math.max(
        0,
        Math.round((row.submitted_at - row.started_at) / 60_000),
      ),
    };
  });
}
