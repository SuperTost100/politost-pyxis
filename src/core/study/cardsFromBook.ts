import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { seedCards } from "./cards";
import { topicExercises } from "./exercises";
import { requireTopic } from "./openLesson";

const TEMPLATE = "cards.generate";
const BATCH = 5;
const ACTIVE = "('queued', 'running', 'interrupted')";

type Params = { planId: string; topicId: string; selection?: ReturnType<typeof selectionFor> };
type Passage = { id: string; text: string };

const text = (max: number) => z.string().trim().min(1).max(max);
const card = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("qa"),
    front: text(400),
    back: text(800),
    passageId: z.string(),
  }),
  z.object({
    kind: z.literal("concept"),
    term: text(200),
    definition: text(800),
    passageId: z.string(),
  }),
  z.object({
    kind: z.literal("cloze"),
    text: text(800),
    extra: text(400),
    passageId: z.string(),
  }),
]);
type GeneratedCard = z.infer<typeof card>;

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

function faces(row: GeneratedCard): { front: string; back: string } {
  if (row.kind === "qa") return { front: row.front, back: row.back };
  if (row.kind === "concept") return { front: row.term, back: row.definition };
  return { front: row.text, back: row.extra };
}

/** Exercises with a worked answer are already real question/answer pairs, so they need no model. */
export function seedExerciseCards(
  db: Database.Database,
  planId: string,
  topicId: string,
): void {
  const pairs = topicExercises(db, topicId)
    .slice(0, 20)
    .flatMap((exercise) =>
      exercise.answer
        ? [
            {
              front: exercise.prompt.slice(0, 400),
              back: exercise.answer.slice(0, 600),
              passageId: exercise.passageId,
            },
          ]
        : [],
    );
  seedCards(db, { planId, topicId, pairs });
}

/** Passages that no generated card (kept, edited or deleted) points to yet. */
function pendingPassages(
  db: Database.Database,
  { planId, topicId }: Params,
  skip: Set<string>,
  limit: number,
): Passage[] {
  return (
    db
      .prepare(
        `SELECT p.id, p.text FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
         WHERE tp.topic_id = ? AND length(trim(p.text)) >= 40
           AND NOT EXISTS (
             SELECT 1 FROM cards c
             WHERE c.plan_id = ? AND c.topic_id = ? AND c.passage_id = p.id AND c.prompt_template = ?)
         ORDER BY p.created_at, p.id`,
      )
      .all(topicId, planId, topicId, TEMPLATE) as Passage[]
  )
    .filter((row) => !skip.has(row.id))
    .slice(0, limit);
}

function batchSchema(batch: Passage[]) {
  const byId = new Map(batch.map((row) => [row.id, row]));
  return z
    .object({
      cards: z
        .array(card)
        .min(batch.length)
        .max(batch.length * 3),
    })
    .superRefine((value, ctx) => {
      const covered = new Set<string>();
      const seen = new Set<string>();
      value.cards.forEach((row, i) => {
        const issue = (message: string) =>
          ctx.addIssue({ code: "custom", message, path: ["cards", i] });
        const passage = byId.get(row.passageId);
        if (!passage) return issue("Unknown passage ID");
        covered.add(row.passageId);
        const { front, back } = faces(row);
        const key = norm(front);
        if (seen.has(key)) issue("Repeated front");
        seen.add(key);
        if (row.kind === "cloze") {
          if (!/\{\{c\d{1,2}::[\s\S]+?\}\}/.test(front))
            issue("Cloze needs a {{c1::answer}} deletion");
        } else if (
          key.length >= 30 &&
          (norm(back).startsWith(key) || norm(passage.text).startsWith(key))
        )
          issue("The front must not be the start of the back or the passage");
      });
      for (const row of batch)
        if (!covered.has(row.id))
          ctx.addIssue({
            code: "custom",
            message: `No card for passage ${row.id}`,
            path: ["cards"],
          });
    });
}

/** Writes one batch atomically; the seed key keeps a re-run from duplicating a card. */
function saveBatch(
  db: Database.Database,
  { planId, topicId }: Params,
  batch: Passage[],
  rows: GeneratedCard[],
  provenance: { provider: string; model: string },
) {
  db.transaction(() => {
    const exists = db.prepare(
      "SELECT 1 FROM cards WHERE plan_id = ? AND topic_id = ? AND seed_key = ?",
    );
    const insert = db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, engine_provider, model_id, model_source,
         prompt_template, prompt_version, grounding, passage_id, seed_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, 'sources', ?, ?, ?)`,
    );
    for (const row of rows) {
      const { front, back } = faces(row);
      const key = `gen:${row.passageId}:${norm(front).slice(0, 160)}`;
      if (exists.get(planId, topicId, key)) continue;
      const now = Date.now();
      insert.run(
        uuidv7(now),
        planId,
        topicId,
        front.trim(),
        back.trim(),
        provenance.provider,
        provenance.model,
        TEMPLATE,
        templateVersion(TEMPLATE),
        row.passageId,
        key,
        now,
      );
    }
    // The old prefix cards for these passages are now replaced, unless studied.
    for (const passage of batch)
      db.prepare(
        `UPDATE cards SET removed = 1
         WHERE plan_id = ? AND topic_id = ? AND passage_id = ? AND prompt_template IS NULL
           AND seed_key IS NOT NULL AND grounding = 'sources' AND TRIM(back) = ?
           AND NOT EXISTS (SELECT 1 FROM card_reviews cr WHERE cr.card_id = cards.id)`,
      ).run(planId, topicId, passage.id, passage.text.slice(0, 600).trim());
  })();
}

export async function generateTopicCards(
  db: Database.Database,
  input: Params,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
) {
  requireTopic(db, input.planId, input.topicId);
  const selection = input.selection ?? selectionFor(db, "lesson");
  const system = systemPrompt(TEMPLATE, {
    contentLanguage: planLanguage(db, input.planId),
  });
  const attempted = new Set<string>();
  while (!signal?.aborted) {
    const batch = pendingPassages(db, input, attempted, BATCH);
    if (!batch.length) break;
    for (const row of batch) attempted.add(row.id);
    const schema = batchSchema(batch);
    const result = await generate({
      selection,
      run,
      signal,
      schema,
      system,
      prompt: JSON.stringify({
        passages: batch.map((row) => ({
          id: row.id,
          text: row.text.slice(0, 1500),
        })),
      }),
    });
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    saveBatch(db, input, batch, (result.data as z.infer<typeof schema>).cards, {
      provider: result.provider,
      model: result.model,
    });
  }
}

export function registerCardJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
) {
  runner.register("cards-build", {
    jobClass: "model-cli",
    retryParams: (params) => ({ ...(params as Params), selection: selectionFor(db, "lesson") }),
    steps: [
      {
        name: "cards",
        label: "jobs.cards",
        async run(ctx) {
          await generateTopicCards(db, ctx.params as Params, run, ctx.signal);
          return true;
        },
      },
    ],
  });
}

/** Seeds exercise cards and starts one durable build for the topic's missing cards. */
export function enqueueTopicCards(
  db: Database.Database,
  runner: Runner,
  input: Params,
): { jobId: string | null } {
  requireTopic(db, input.planId, input.topicId);
  seedExerciseCards(db, input.planId, input.topicId);
  const active = db
    .prepare(
      `SELECT id FROM jobs WHERE kind = 'cards-build' AND state IN ${ACTIVE}
         AND json_extract(params_json, '$.planId') = ? AND json_extract(params_json, '$.topicId') = ?
       LIMIT 1`,
    )
    .get(input.planId, input.topicId) as { id: string } | undefined;
  if (active) return { jobId: active.id };
  if (!pendingPassages(db, input, new Set(), 1).length) return { jobId: null };
  return {
    jobId: runner.start("cards-build", {
      planId: input.planId,
      topicId: input.topicId,
      selection: selectionFor(db, "lesson"),
    }),
  };
}

/** Latest build for the topic, without error text: engine output can echo course material. */
export function readCardsBuild(
  db: Database.Database,
  { planId, topicId }: Params,
): { jobId: string; state: string } | null {
  const row = db
    .prepare(
      `SELECT id, state FROM jobs WHERE kind = 'cards-build'
         AND json_extract(params_json, '$.planId') = ? AND json_extract(params_json, '$.topicId') = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(planId, topicId) as { id: string; state: string } | undefined;
  return row ? { jobId: row.id, state: row.state } : null;
}
