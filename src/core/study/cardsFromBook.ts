import { interestsLine } from "../profile/context";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { requireTopic } from "./openLesson";

const TEMPLATE = "cards.generate";
const BATCH = 5;
const ACTIVE = "('queued', 'running', 'interrupted')";

type Params = { planId: string; topicId: string; selection?: ReturnType<typeof selectionFor> };
type Passage = { id: string; text: string };

// A card asks for one fact, definition, formula or idea. These caps keep a worked exercise out.
const FRONT_MAX = 200;
const BACK_MAX = 300;
/** A cloze sentence carries its {{c1::...}} markup, so it gets a little more room. */
const CLOZE_MAX = 240;

const text = (max: number) => z.string().trim().min(1).max(max);
/** The three card forms, with the shape of the passage link left to the caller (cards made from pasted text may have none). */
export const cardOf = <P extends z.ZodType>(passageId: P) =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("qa"),
      front: text(FRONT_MAX),
      back: text(BACK_MAX),
      passageId,
    }),
    z.object({
      kind: z.literal("concept"),
      term: text(FRONT_MAX),
      definition: text(BACK_MAX),
      passageId,
    }),
    z.object({
      kind: z.literal("cloze"),
      text: text(CLOZE_MAX),
      extra: text(BACK_MAX),
      passageId,
    }),
  ]);
const card = cardOf(z.string());
type GeneratedCard = z.infer<typeof card>;

export const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

const DISPLAY_MATH = /\$\$|\\\[|\\begin\{/;
const LIST_LINE = /^\s*(?:\d+[.)]|[-*\u2022])\s/;

/** Why a face is a worked solution rather than one fact, or null when it is fine. */
function solutionLike(face: string): string | null {
  if (DISPLAY_MATH.test(face)) return "A card holds no display-math derivation";
  if (/\n\s*\n/.test(face)) return "A card holds one paragraph";
  const lines = face.split("\n").filter((line) => line.trim());
  if (lines.length > 2 || lines.filter((line) => LIST_LINE.test(line)).length > 1)
    return "A card holds one fact, not steps";
  return null;
}

type CardFaces =
  | { kind: "qa"; front: string; back: string }
  | { kind: "concept"; term: string; definition: string }
  | { kind: "cloze"; text: string; extra: string };

export function faces(row: CardFaces): { front: string; back: string } {
  if (row.kind === "qa") return { front: row.front, back: row.back };
  if (row.kind === "concept") return { front: row.term, back: row.definition };
  return { front: row.text, back: row.extra };
}

/**
 * What is wrong with one generated card, as repair messages for the model: a worked solution on either face, a front
 * already used in the same reply (`seen` collects them), a cloze without a deletion, or a long front that is only the
 * start of its back or of the `source` it was written from (`sourceName` names that in the message).
 */
export function cardIssues(
  row: CardFaces,
  seen: Set<string>,
  source: string,
  sourceName: "passage" | "text",
): string[] {
  const issues: string[] = [];
  const { front, back } = faces(row);
  for (const face of [front, back]) {
    const reason = solutionLike(face);
    if (reason) issues.push(reason);
  }
  const key = norm(front);
  if (seen.has(key)) issues.push("Repeated front");
  seen.add(key);
  if (row.kind === "cloze") {
    if (!/\{\{c\d{1,2}::[\s\S]+?\}\}/.test(front))
      issues.push("Cloze needs a {{c1::answer}} deletion");
  } else if (
    key.length >= 30 &&
    (norm(back).startsWith(key) || norm(source).startsWith(key))
  )
    issues.push(`The front must not be the start of the back or the ${sourceName}`);
  return issues;
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
        for (const message of cardIssues(row, seen, passage.text, "passage")) issue(message);
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

/**
 * The calls one build makes at once. The step holds one CLI slot, like the plan build's intro step, and makes as many
 * calls as the default CLI limit allows.
 */
const PARALLEL_CALLS = 2;

/**
 * Writes cards for the topic's passages that have none yet, five passages per model call and two calls at a time. Each
 * batch is stored as its call returns, so the page can show its cards before the rest arrive; `onProgress` gets the
 * share of passages done after each batch.
 */
export async function generateTopicCards(
  db: Database.Database,
  input: Params,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
) {
  requireTopic(db, input.planId, input.topicId);
  const selection = input.selection ?? selectionFor(db, "lesson");
  const system = [
    systemPrompt(TEMPLATE, { contentLanguage: planLanguage(db, input.planId) }),
    interestsLine(db),
  ]
    .filter(Boolean)
    .join("\n");
  const attempted = new Set<string>();
  const total = pendingPassages(db, input, attempted, Number.MAX_SAFE_INTEGER).length;
  let done = 0;
  let failed = false;
  async function worker() {
    // A failed call stops the other worker from starting a new batch; the batch it already has out is still stored.
    while (!signal?.aborted && !failed) {
      const batch = pendingPassages(db, input, attempted, BATCH);
      if (!batch.length) return;
      for (const row of batch) attempted.add(row.id);
      const schema = batchSchema(batch);
      try {
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
      } catch (error) {
        failed = true;
        throw error;
      }
      done += batch.length;
      if (total) onProgress?.(Math.min(1, done / total));
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: PARALLEL_CALLS }, () => worker()),
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected) throw rejected.reason;
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
          await generateTopicCards(db, ctx.params as Params, run, ctx.signal, ctx.progress);
          return true;
        },
      },
    ],
  });
}

/** Starts one durable build for the topic's missing cards. */
export function enqueueTopicCards(
  db: Database.Database,
  runner: Runner,
  input: Params,
): { jobId: string | null } {
  requireTopic(db, input.planId, input.topicId);
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

/**
 * Latest build for the topic, without error text: engine output can echo course material. Its progress moves each time
 * a batch of cards is stored, which tells the page to load them.
 */
export function readCardsBuild(
  db: Database.Database,
  { planId, topicId }: Params,
): { jobId: string; state: string; progress: number } | null {
  const row = db
    .prepare(
      `SELECT id, state, progress FROM jobs WHERE kind = 'cards-build'
         AND json_extract(params_json, '$.planId') = ? AND json_extract(params_json, '$.topicId') = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(planId, topicId) as { id: string; state: string; progress: number } | undefined;
  return row ? { jobId: row.id, state: row.state, progress: row.progress } : null;
}
