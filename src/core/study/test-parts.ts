import type Database from "better-sqlite3";
import { cacheKey } from "./lesson";

// Tests only. Seeds a topic's lesson in parts straight into the database, the rows the part-writing job saves: an
// outline, its parts in reading order and, for each written part, an ordinary `lesson` item whose cache key has the
// part's id as its scope.

/** A quick check block as the model writes it; `answer` is the index of the right option. */
export function checkBlock(question: string, answer = 0): string {
  return [
    "```pyxis-check",
    JSON.stringify({ question, options: ["Giusta", "Sbagliata", "Altra"], answer, explanation: "Perché sì." }),
    "```",
  ].join("\n");
}

/** A teaching part's text: two sections and one check at the end, the shape a written part has. */
export function partMarkdown(name: string): string {
  return [`## ${name}`, "", `Che cosa dice ${name}.`, "", `## ${name}, in pratica`, "", "Un esempio.", "", checkBlock(`Che cos'è ${name}?`)].join(
    "\n",
  );
}

/** A recap part's text: one section and a recap of three questions. */
export function recapMarkdown(name: string): string {
  const questions = [1, 2, 3].map((n) => ({ question: `${name}: domanda ${n}`, options: ["a", "b"], answer: 0 }));
  return [`## ${name}`, "", "- Un punto per parte.", "", "```pyxis-recap", JSON.stringify({ questions }), "```"].join("\n");
}

export type SeedPart = {
  kind?: "part" | "recap";
  title?: string;
  minutes?: number;
  /** The written text. Absent or null leaves the part unwritten. */
  markdown?: string | null;
  doneAt?: number | null;
};

export type SeededOutline = {
  outlineId: string;
  parts: Array<{ id: string; position: number; itemId: string | null }>;
};

/**
 * Saves an outline of `parts` on a topic, with an item for every part that has `markdown`. Ids are made from the
 * outline's id (`<outline>-p<position>` for a part, `<outline>-i<position>` for its item), so a test can name them.
 */
export function seedOutline(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    parts: SeedPart[];
    id?: string;
    createdAt?: number;
    retiredAt?: number | null;
    replacesItemId?: string | null;
  },
): SeededOutline {
  const outlineId = input.id ?? `outline-${input.topicId}`;
  const createdAt = input.createdAt ?? 1;
  db.prepare(
    `INSERT INTO lesson_outlines (id, plan_id, topic_id, passage_key, origin, replaces_item_id, created_at, retired_at)
     VALUES (?, ?, ?, 'key', 'model', ?, ?, ?)`,
  ).run(outlineId, input.planId, input.topicId, input.replacesItemId ?? null, createdAt, input.retiredAt ?? null);
  const parts = input.parts.map((part, index) => {
    const position = index + 1;
    const id = `${outlineId}-p${position}`;
    db.prepare(
      `INSERT INTO lesson_parts (id, outline_id, position, kind, title, minutes, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, outlineId, position, part.kind ?? "part", part.title ?? `Parte ${position}`, part.minutes ?? 5, part.doneAt ?? null);
    const itemId =
      part.markdown == null
        ? null
        : writeSeedPart(db, { planId: input.planId, topicId: input.topicId, partId: id, markdown: part.markdown, createdAt, itemId: `${outlineId}-i${position}` });
    return { id, position, itemId };
  });
  return { outlineId, parts };
}

/**
 * Writes a part's text as a new `lesson` item and points the part at it, as writing the part again at another level
 * does: the earlier item stays, with its answers. `wording` goes into the cache key, so each level is its own item.
 */
export function writeSeedPart(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    partId: string;
    markdown: string;
    wording?: string;
    itemId?: string;
    createdAt?: number;
  },
): string {
  const itemId = input.itemId ?? `${input.partId}-${input.wording ?? "balanced"}`;
  const key = cacheKey({ kind: "lesson", scopeId: input.partId, passageIds: [], promptVersion: `part-1|${input.wording ?? "balanced"}` });
  db.prepare(
    `INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, model_id, model_source, prompt_template,
       prompt_version, grounding, created_at)
     VALUES (?, ?, ?, 'lesson', ?, 'claude', 'm', 'reported', 'lesson.part', 'part-1', 'general', ?)`,
  ).run(itemId, input.planId, input.topicId, JSON.stringify({ cacheKey: key, markdown: input.markdown, passageIds: [] }), input.createdAt ?? 1);
  db.prepare("UPDATE lesson_parts SET item_id = ? WHERE id = ?").run(itemId, input.partId);
  return itemId;
}
