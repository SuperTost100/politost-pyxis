import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { checkClaimSchema } from "../../shared/math-check";
import { generate, type GenerateInput } from "../engine/generate";
import {
  contentLanguage,
  systemPrompt,
  promptProvenance,
} from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { topicExercises } from "./exercises";
import { requireTopic } from "./openLesson";

type Input = { planId: string; topicId: string };
type Params = {
  selection?: ReturnType<typeof selectionFor>;
  input: Input;
  batchId: string;
  topic: string;
  language: string;
  education: string;
  passages: Array<{ id: string; text: string }>;
};

// ponytail: same one-call budget as lessons; the exercises come from the topic's opening passages.
const CONTEXT_CHARS = 24_000;
const PASSAGE_CHARS = 4_000;
const PROMPT = promptProvenance("exercise.generate");

const generatedSchema = z.object({
  exercises: z
    .array(
      z.object({
        statement: z.string().trim().min(1).max(4000),
        steps: z
          .array(
            z.object({
              text: z.string().trim().min(1).max(1000),
              latex: z.string().trim().max(1000).optional(),
              check: checkClaimSchema.optional(),
            }),
          )
          .min(1)
          .max(12),
        finalAnswer: z.string().trim().min(1).max(2000),
        hints: z.array(z.string().trim().min(1).max(500)).max(3).optional(),
        sources: z.array(z.string()).min(1).max(8),
      }),
    )
    .min(1)
    .max(5),
});

function system(params: Params): string {
  return `${systemPrompt("exercise.generate", { contentLanguage: params.language })}\nReader education level: ${params.education}.`;
}

export function prepareExercises(db: Database.Database, input: Input): Params {
  requireTopic(db, input.planId, input.topicId);
  const topic = db
    .prepare(
      "SELECT t.title, p.content_language AS language FROM topics t JOIN plans p ON p.id = t.plan_id WHERE t.id = ? AND p.id = ?",
    )
    .get(input.topicId, input.planId) as {
    title: string;
    language: string | null;
  };
  const rows = db
    .prepare(
      "SELECT p.id, p.text FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ? ORDER BY p.created_at, p.id",
    )
    .all(input.topicId) as Array<{ id: string; text: string }>;
  const passages: Params["passages"] = [];
  let size = 0;
  for (const row of rows) {
    const text = row.text.slice(0, PASSAGE_CHARS);
    if (passages.length && size + text.length > CONTEXT_CHARS) break;
    passages.push({ id: row.id, text });
    size += text.length;
  }
  if (!passages.length) throw new Error("exercises-no-sources");
  const profile = db
    .prepare("SELECT education_level FROM profile LIMIT 1")
    .get() as { education_level: string | null } | undefined;
  return {
    input,
    selection: selectionFor(db, "lesson"),
    batchId: uuidv7(),
    topic: topic.title,
    language: contentLanguage(db, topic.language),
    education: profile?.education_level?.trim() || "university",
    passages,
  };
}

async function build(
  db: Database.Database,
  params: Params,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
) {
  const ids = new Set(params.passages.map((passage) => passage.id));
  const schema = generatedSchema.superRefine((value, ctx) => {
    if (value.exercises.some((item) => item.sources.some((id) => !ids.has(id))))
      ctx.addIssue({ code: "custom", message: "Unknown passage ID" });
  });
  const result = await generate({
    selection: params.selection ?? selectionFor(db, "lesson"),
    run,
    signal,
    schema,
    system: system(params),
    prompt: JSON.stringify({
      topic: params.topic,
      passages: params.passages,
    }),
  });
  signal?.throwIfAborted();
  const value = result.data as z.infer<typeof schema>;
  db.transaction(() => {
    // A resumed job whose save already landed must not duplicate it.
    const done = db
      .prepare(
        "SELECT 1 FROM exercises WHERE smartbook_id IS NULL AND json_extract(locator_json, '$.batchId') = ? LIMIT 1",
      )
      .get(params.batchId);
    if (done) return;
    const insert = db.prepare(
      `INSERT INTO exercises
        (id, smartbook_id, passage_id, prompt, answer, locator_json, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, 'sources', ?)`,
    );
    const now = Date.now();
    value.exercises.forEach((item, index) => {
      insert.run(
        uuidv7(now + index),
        item.sources[0],
        item.statement,
        item.finalAnswer,
        JSON.stringify({
          kind: "generated",
          batchId: params.batchId,
          topicId: params.input.topicId,
          passageIds: item.sources,
          steps: item.steps,
          hints: item.hints ?? [],
        }),
        result.provider,
        result.model,
        PROMPT.template,
        PROMPT.version,
        now + index,
      );
    });
  })();
}

export function registerExerciseJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
): void {
  runner.register("exercise-build", {
    jobClass: "model-cli",
    retryParams: (params) => ({ ...(params as Params), selection: selectionFor(db, "lesson") }),
    steps: [
      {
        name: "exercises",
        label: "jobs.exercises",
        async run(ctx) {
          await build(db, ctx.params as Params, run, ctx.signal);
          return true;
        },
      },
    ],
  });
}

/** Latest job for the topic, for the page to follow. */
export function exerciseJob(db: Database.Database, input: Input) {
  const row = db
    .prepare(
      "SELECT id AS jobId, state, error FROM jobs WHERE kind = 'exercise-build' AND dismissed = 0 AND json_extract(params_json, '$.input.planId') = ? AND json_extract(params_json, '$.input.topicId') = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(input.planId, input.topicId) as
    { jobId: string; state: string; error: string | null } | undefined;
  return row ?? null;
}

/** Starts, retries or resumes the topic's job; originals and earlier generated exercises are never replaced. */
export function enqueueExercises(
  db: Database.Database,
  runner: Runner,
  input: Input,
) {
  requireTopic(db, input.planId, input.topicId);
  if (topicExercises(db, input.topicId).length > 0) return;
  const existing = exerciseJob(db, input);
  if (existing && existing.state !== "succeeded") {
    if (existing.state === "failed" || existing.state === "cancelled")
      runner.retry(existing.jobId);
    else if (existing.state === "interrupted") runner.resume(existing.jobId);
    return;
  }
  runner.start("exercise-build", prepareExercises(db, input));
}
