import { interestsLine } from "../profile/context";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { cardOf, faces, norm, solutionLike } from "./cardsFromBook";
import { requireTopic } from "./openLesson";

const TEMPLATE = "cards.text";
const MAX_CARDS = 8;
/** shortcut: a longer text is cut here, not split into several requests; upgrade when replies or selections regularly pass it. */
const TEXT_MAX = 6000;
/** Source passages sent along so a card can name where its fact comes from. */
const PASSAGES_MAX = 4;
const PASSAGE_CHARS = 600;

export type CardPlaces = {
  plans: Array<{
    id: string;
    title: string;
    subject: string | null;
    topics: Array<{ id: string; title: string }>;
  }>;
  /** Preselected plan and topic, or null when nothing in the request points to one. */
  planId: string | null;
  topicId: string | null;
};

/**
 * The plans and topics a card can be filed under, with a first guess. A request that names a plan or a topic keeps it.
 * Otherwise a subject picks its latest plan, and the passages the text cites pick the plan and topic they belong to most.
 */
export function cardPlaces(
  db: Database.Database,
  input: {
    planId?: string;
    topicId?: string;
    subject?: string;
    passageIds?: string[];
  },
): CardPlaces {
  const rows = db
    .prepare(
      `SELECT p.id AS plan_id, p.title AS plan_title, s.name AS subject, t.id AS topic_id, t.title AS topic_title
       FROM plans p
       JOIN topics t ON t.plan_id = p.id AND t.archived_at IS NULL
       LEFT JOIN subjects s ON s.id = p.subject_id
       ORDER BY p.updated_at DESC, p.id, t.position, t.created_at`,
    )
    .all() as Array<{
    plan_id: string;
    plan_title: string;
    subject: string | null;
    topic_id: string;
    topic_title: string;
  }>;
  const plans: CardPlaces["plans"] = [];
  for (const row of rows) {
    let plan = plans.at(-1);
    if (plan?.id !== row.plan_id) {
      plan = {
        id: row.plan_id,
        title: row.plan_title,
        subject: row.subject,
        topics: [],
      };
      plans.push(plan);
    }
    plan.topics.push({ id: row.topic_id, title: row.topic_title });
  }

  const votes = new Map<string, number>();
  if (input.passageIds?.length)
    for (const row of db
      .prepare(
        `SELECT topic_id, COUNT(*) AS n FROM topic_passages
         WHERE passage_id IN (SELECT value FROM json_each(?)) GROUP BY topic_id`,
      )
      .all(JSON.stringify(input.passageIds)) as Array<{
      topic_id: string;
      n: number;
    }>)
      votes.set(row.topic_id, row.n);
  const planVotes = (plan: CardPlaces["plans"][number]) =>
    plan.topics.reduce((sum, topic) => sum + (votes.get(topic.id) ?? 0), 0);
  /** First of the candidates with the most votes; the list order breaks a tie. */
  const best = <T>(list: T[], score: (item: T) => number): T | undefined => {
    let found: T | undefined;
    let top = 0;
    for (const item of list) {
      const value = score(item);
      if (value > top) {
        found = item;
        top = value;
      }
    }
    return found;
  };

  const named = plans.find((plan) => plan.id === input.planId);
  const ofSubject = input.subject
    ? plans.filter((plan) => plan.subject === input.subject)
    : [];
  const plan =
    named ??
    best(ofSubject, planVotes) ??
    ofSubject[0] ??
    best(plans, planVotes);
  const topic =
    plan?.topics.find((item) => item.id === input.topicId) ??
    (plan ? best(plan.topics, (item) => votes.get(item.id) ?? 0) : undefined);
  return { plans, planId: plan?.id ?? null, topicId: topic?.id ?? null };
}

type Passage = { id: string; text: string };

const tokens = (value: string) =>
  new Set(
    norm(value)
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]{4,}/gu) ?? [],
  );

/** The passages that share the most words with the text, so a long list of citations stays a short prompt. */
function closestPassages(text: string, passages: Passage[]): Passage[] {
  if (passages.length <= PASSAGES_MAX) return passages;
  const wanted = tokens(text);
  const scored = passages
    .map((passage, order) => {
      let score = 0;
      for (const word of tokens(passage.text)) if (wanted.has(word)) score += 1;
      return { passage, order, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, PASSAGES_MAX)
    .map((row) => row.passage);
  // A short or formula-only text shares no word with anything: keep the first cited passages rather than none.
  return scored.length ? scored : passages.slice(0, PASSAGES_MAX);
}

function proposalSchema(passages: Passage[], text: string) {
  const known = new Set(passages.map((row) => row.id));
  return z
    .object({
      cards: z.array(cardOf(z.string().nullable())).min(1).max(MAX_CARDS),
    })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      value.cards.forEach((row, i) => {
        const issue = (message: string) =>
          ctx.addIssue({ code: "custom", message, path: ["cards", i] });
        if (row.passageId !== null && !known.has(row.passageId))
          issue("Unknown passage ID");
        const { front, back } = faces(row);
        for (const face of [front, back]) {
          const reason = solutionLike(face);
          if (reason) issue(reason);
        }
        const key = norm(front);
        if (seen.has(key)) issue("Repeated front");
        seen.add(key);
        if (row.kind === "cloze") {
          if (!/\{\{c\d{1,2}::[\s\S]+?\}\}/.test(front))
            issue("Cloze needs a {{c1::answer}} deletion");
        } else if (
          key.length >= 30 &&
          (norm(back).startsWith(key) || norm(text).startsWith(key))
        )
          issue("The front must not be the start of the back or the text");
      });
    });
}

export type ProposedCard = {
  front: string;
  back: string;
  passageId: string | null;
};

/** Cards the model proposes for a piece of text. Nothing is stored: the student reviews them first. */
export async function proposeCards(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    text: string;
    passageIds: string[];
  },
  run?: GenerateInput["run"],
  signal?: AbortSignal,
): Promise<{ cards: ProposedCard[]; provider: string; model: string }> {
  requireTopic(db, input.planId, input.topicId);
  const text = input.text.trim().slice(0, TEXT_MAX);
  if (!text) throw new Error("card-blank");
  const found = input.passageIds.length
    ? (db
        .prepare(
          `SELECT id, text FROM passages WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(input.passageIds)) as Passage[])
    : [];
  const order = new Map(input.passageIds.map((id, i) => [id, i]));
  const passages = closestPassages(
    text,
    found.sort((a, b) => order.get(a.id)! - order.get(b.id)!),
  ).map((row) => ({ id: row.id, text: row.text.slice(0, PASSAGE_CHARS) }));
  const schema = proposalSchema(passages, text);
  const result = await generate({
    selection: selectionFor(db, "lesson"),
    run,
    signal,
    schema,
    system: [
      systemPrompt(TEMPLATE, {
        contentLanguage: planLanguage(db, input.planId),
      }),
      interestsLine(db),
    ]
      .filter(Boolean)
      .join("\n"),
    prompt: JSON.stringify({ text, passages }),
  });
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const data = result.data as z.infer<typeof schema>;
  return {
    cards: data.cards.map((row) => ({
      ...faces(row),
      passageId: row.passageId,
    })),
    provider: result.provider,
    model: result.model,
  };
}

/**
 * Files the cards the student kept. They start like any new card: no review yet, so they are due at once.
 * A front the topic already has is skipped, so saving twice adds nothing.
 */
export function saveProposedCards(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    cards: ProposedCard[];
    provider: string;
    model: string;
  },
): { saved: number; skipped: number } {
  requireTopic(db, input.planId, input.topicId);
  return db.transaction(() => {
    // Same comparison as the proposal check and seed_key: case and spacing do not make a new front.
    const present = new Set(
      (
        db
          .prepare(
            `SELECT front FROM cards WHERE plan_id = ? AND topic_id = ? AND removed = 0`,
          )
          .all(input.planId, input.topicId) as Array<{ front: string }>
      ).map((row) => norm(row.front)),
    );
    const passage = db.prepare("SELECT 1 FROM passages WHERE id = ?");
    const insert = db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, engine_provider, model_id, model_source,
         prompt_template, prompt_version, grounding, passage_id, seed_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?)`,
    );
    let saved = 0;
    for (const row of input.cards) {
      const front = row.front.trim();
      const back = row.back.trim();
      if (!front || !back) throw new Error("card-blank");
      if (present.has(norm(front))) continue;
      present.add(norm(front));
      const linked =
        row.passageId && passage.get(row.passageId) ? row.passageId : null;
      const now = Date.now();
      insert.run(
        uuidv7(now),
        input.planId,
        input.topicId,
        front,
        back,
        input.provider,
        input.model,
        TEMPLATE,
        templateVersion(TEMPLATE),
        linked ? "sources" : "general",
        linked,
        `text:${norm(front).slice(0, 160)}`,
        now,
      );
      saved += 1;
    }
    return { saved, skipped: input.cards.length - saved };
  })();
}
