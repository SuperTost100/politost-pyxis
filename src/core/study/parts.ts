import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";
import { parseLooseJson, parseSmartText, smartSections } from "../../shared/smart-text";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, promptProvenance, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { figureRunner, type FigureRunner } from "../math/figures";
import { interestsLine } from "../profile/context";
import { cacheKey, saveLesson } from "./lesson";
import {
  CONTEXT_CHARS,
  lessonSystem,
  lessonText,
  materialText,
  modelContext,
  requireTopic,
  withFigures,
  wordings,
  type Wording,
} from "./openLesson";

// A topic's lesson in short parts: how many parts, the plan of them (the outline) and its checks, then writing one part
// and checking its shape. The job that writes a part, and the rule that keeps it to one part ahead, are in partJobs.ts.

/** A topic with at most this many characters of material is one part, made with no planning call. */
export const ONE_PART_CHARS = 7_000;
/** The material one teaching part aims at: the target number of parts is the topic's characters over this, rounded. */
export const PART_CHARS = 6_000;
/** Fewest and most teaching parts of a planned topic. The cap keeps a long topic from becoming 20 parts. */
export const MIN_PARTS = 2;
export const MAX_PARTS = 8;
/** How far the model's reply may move the target, in parts. */
export const PART_SLACK = 1;
/** From this many teaching parts on, a recap part follows them. */
export const RECAP_FROM = 3;
/** The passage list of the planning call stays within the bound every lesson call has. */
export const OUTLINE_PROMPT_CHARS = CONTEXT_CHARS;
/** An unwritten part's minutes: its material read at this many characters a minute, plus a fixed share, kept in bounds. */
export const ESTIMATE_CHARS_PER_MINUTE = 1_500;
export const ESTIMATE_EXTRA_MINUTES = 3;
export const ESTIMATE_MIN_MINUTES = 4;
export const ESTIMATE_MAX_MINUTES = 8;
/** The recap's minutes until it is written. */
export const RECAP_MINUTES = 4;
/** The fallback prefers a cut where the section changes when the part is within this share of its target size. */
export const SECTION_SLACK = 0.25;
/** Longest part title, in the reply and in the fallback. */
const TITLE_CHARS = 80;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export type PartBounds = { target: number; min: number; max: number };

/**
 * How many teaching parts a topic gets, or null when it is one part and needs no planning call: at most
 * `ONE_PART_CHARS` of material, or fewer passages than `MIN_PARTS` (a passage is never split between parts). A part
 * needs a passage of its own, so the passage count caps the target too.
 */
export function partBounds(chars: number, passages: number): PartBounds | null {
  if (chars <= ONE_PART_CHARS || passages < MIN_PARTS) return null;
  const most = Math.min(MAX_PARTS, passages);
  const target = clamp(Math.round(chars / PART_CHARS), MIN_PARTS, most);
  return {
    target,
    min: Math.max(MIN_PARTS, target - PART_SLACK),
    max: Math.min(most, target + PART_SLACK),
  };
}

/** Minutes of an unwritten teaching part with this much material. */
export function estimateMinutes(chars: number): number {
  return clamp(
    Math.round(chars / ESTIMATE_CHARS_PER_MINUTE) + ESTIMATE_EXTRA_MINUTES,
    ESTIMATE_MIN_MINUTES,
    ESTIMATE_MAX_MINUTES,
  );
}

/** The planning call's reply. The first property is `lessonParts`, so the recorded engine answers it by name. */
export const outlineReply = z.object({
  lessonParts: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(TITLE_CHARS),
        about: z.string().trim().max(200),
        passages: z.array(z.string().regex(/^P\d+$/)).max(400),
      }),
    )
    .min(1)
    .max(MAX_PARTS + PART_SLACK),
});
export type OutlineReply = z.infer<typeof outlineReply>;

/** One teaching part as planned, before it has a row. */
export type PlannedPart = { title: string; about: string; passageIds: string[] };

export type OutlineCheck = { ok: true; parts: PlannedPart[] } | { ok: false; problems: string[] };

/** A title as two titles are compared: case and spaces ignored. */
const foldTitle = (title: string) => title.normalize("NFC").toLocaleLowerCase().replace(/\s+/g, "");

/**
 * Repairs what it can in a reply and rejects the rest, with one line per broken rule for the second ask. `passageIds`
 * are the topic's passages in reading order, labelled P1, P2 and so on in the call. Repairs: an unknown label is
 * dropped; a passage in two parts stays in the first part that lists it; a part's passages are sorted into reading
 * order and the parts by their first passage; a part left with no passage is dropped; a passage in no part joins the
 * part of the nearest earlier passage, or the first part. Rejections: fewer than `min` or more than `max` parts after
 * the repairs, and an empty or repeated title. What it accepts gives every passage to exactly one part.
 */
export function checkOutline(
  reply: OutlineReply,
  passageIds: readonly string[],
  bounds: Pick<PartBounds, "min" | "max">,
): OutlineCheck {
  const labels = new Map(passageIds.map((_, index) => [`P${index + 1}`, index]));
  const owner = new Map<number, { title: string; about: string; indexes: number[] }>();
  const listed = reply.lessonParts.map((part) => ({ title: part.title.trim(), about: part.about.trim(), indexes: [] as number[] }));
  reply.lessonParts.forEach((part, at) => {
    for (const label of part.passages) {
      const index = labels.get(label);
      if (index === undefined || owner.has(index)) continue;
      owner.set(index, listed[at]!);
      listed[at]!.indexes.push(index);
    }
  });
  const parts = listed.filter((part) => part.indexes.length > 0);
  for (const part of parts) part.indexes.sort((a, b) => a - b);
  parts.sort((a, b) => a.indexes[0]! - b.indexes[0]!);
  let previous = parts[0];
  for (let index = 0; previous && index < passageIds.length; index++) {
    const part = owner.get(index);
    if (part) previous = part;
    else previous.indexes.push(index);
  }
  for (const part of parts) part.indexes.sort((a, b) => a - b);

  const problems: string[] = [];
  if (parts.length < bounds.min || parts.length > bounds.max)
    problems.push(
      `The reply had ${parts.length} parts with passages from the list. Use ${
        bounds.min === bounds.max ? bounds.min : `between ${bounds.min} and ${bounds.max}`
      }.`,
    );
  if (parts.some((part) => foldTitle(part.title) === "")) problems.push("A part has no title. Give every part a title.");
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const part of parts) {
    const key = foldTitle(part.title);
    if (!key) continue;
    if (seen.has(key) && !repeated.has(key)) {
      repeated.add(key);
      problems.push(`Two parts have the title "${part.title}". Give each part its own title.`);
    }
    seen.add(key);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    parts: parts.map((part) => ({
      title: part.title,
      about: part.about,
      passageIds: part.indexes.map((index) => passageIds[index]!),
    })),
  };
}

/** A passage as planning reads it: `section` is its heading, or null when it has none worth naming. */
export type OutlinePassage = { id: string; text: string; section: string | null };

/** The plan's word for a part, as in "Parte 3": Italian for Italian material, English for any other language. */
function partName(language: string, position: number): string {
  return `${language === "Italian" ? "Parte" : "Part"} ${position}`;
}

function recapTitle(language: string): string {
  return language === "Italian" ? "Ripasso del capitolo" : "Chapter recap";
}

/** A heading as a part title: without its numbering ("2.1 Intorni" is "Intorni"), and at most `TITLE_CHARS` long. */
function headingTitle(section: string): string {
  const title = section.replace(/^\d+(?:\.\d+)*\.?\s+/, "").trim() || section.trim();
  return Array.from(title).slice(0, TITLE_CHARS).join("").trim();
}

/**
 * Cuts a topic into at most `count` parts without a model. It walks the passages in reading order and closes a part
 * once it holds its share of what is left, never splitting a passage and never leaving a part empty. Within
 * `SECTION_SLACK` of that share it cuts where the section changes instead. Each part is titled with the heading of its
 * first passage, or "Parte N" ("Part N") when it has none, and a repeated title gets its number, as in "Intorni (2)".
 * A topic with no passages is one part.
 */
export function fallbackOutline(passages: readonly OutlinePassage[], count: number, language: string): PlannedPart[] {
  const most = clamp(Number.isFinite(count) ? Math.round(count) : 1, 1, MAX_PARTS);
  if (passages.length === 0) return [{ title: partName(language, 1), about: "", passageIds: [] }];
  // Where a new section starts: the passage has a heading that differs from the last heading before it.
  const starts: boolean[] = [];
  let heading: string | null = null;
  for (const passage of passages) {
    starts.push(passage.section !== null && passage.section !== heading);
    heading = passage.section ?? heading;
  }
  const groups: OutlinePassage[][] = [];
  let left = passages.reduce((sum, passage) => sum + passage.text.length, 0);
  let current: OutlinePassage[] = [];
  let size = 0;
  let share = left / most;
  const sectionAhead = (from: number) => {
    let grown = size;
    for (let index = from; index < passages.length; index++) {
      if (index > from && starts[index]) return true;
      grown += passages[index]!.text.length;
      if (grown > share * (1 + SECTION_SLACK)) return false;
    }
    return false;
  };
  passages.forEach((passage, index) => {
    const cut =
      current.length > 0 &&
      groups.length < most - 1 &&
      ((starts[index] && size >= share * (1 - SECTION_SLACK)) || (size >= share && !sectionAhead(index)));
    if (cut) {
      groups.push(current);
      left -= size;
      current = [];
      size = 0;
      share = left / (most - groups.length);
    }
    current.push(passage);
    size += passage.text.length;
  });
  groups.push(current);
  const used = new Set<string>();
  return groups.map((group, index) => {
    const base = (group[0]!.section ? headingTitle(group[0]!.section) : "") || partName(language, index + 1);
    let title = base;
    for (let number = 2; used.has(foldTitle(title)); number++)
      title = `${Array.from(base).slice(0, TITLE_CHARS - 6).join("").trim()} (${number})`;
    used.add(foldTitle(title));
    return { title, about: "", passageIds: group.map((passage) => passage.id) };
  });
}

/** A page, a slide or an untitled chunk is where a passage sits, not what it is about, so it names no section. */
const LOCATOR_SECTION = /^(?:p\.|slide) \d+$|^text$/;

/** The heading of a passage: a smartbook paragraph's title, else its section path unless that is only a locator. */
function passageSection(sectionPath: string | null, locatorJson: string | null): string | null {
  // `locator_json` is checked with `json_valid` on every write, so it always parses.
  const title = locatorJson ? (JSON.parse(locatorJson) as { title?: unknown } | null)?.title : undefined;
  if (typeof title === "string" && title.trim()) return title.trim();
  const path = sectionPath?.trim();
  return path && !LOCATOR_SECTION.test(path) ? path : null;
}

/** A topic's passages in reading order, the order its lesson teaches them in. */
export function outlinePassages(db: Database.Database, topicId: string): OutlinePassage[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.text, p.section_path, p.locator_json
       FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at, p.id`,
    )
    .all(topicId) as Array<{ id: string; text: string; section_path: string | null; locator_json: string | null }>;
  return rows.map((row) => ({ id: row.id, text: row.text, section: passageSection(row.section_path, row.locator_json) }));
}

/** The first `count` characters of a passage, with its runs of white space as one space. */
function excerpt(text: string, count: number): string {
  if (count <= 0) return "";
  const flat = text.slice(0, count * 4).replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, count).join("");
}

export type OutlineRequest = {
  topic: string;
  parts: PartBounds;
  passages: Array<{ label: string; section?: string; chars: number; excerpt: string }>;
  problems?: string[];
};

/**
 * The planning call's input. Each passage is listed by its label, its heading when it starts a new one, its length and
 * its first characters, cut to an equal share so the whole list stays within `OUTLINE_PROMPT_CHARS`. Null when even the
 * labels and lengths alone do not fit: the topic is then cut by the fallback without a call.
 */
export function outlineRequest(
  topic: string,
  passages: readonly OutlinePassage[],
  bounds: PartBounds,
): OutlineRequest | null {
  let heading: string | null = null;
  const bare = passages.map((passage, index) => {
    const section = passage.section !== null && passage.section !== heading ? passage.section : undefined;
    heading = passage.section ?? heading;
    return { label: `P${index + 1}`, ...(section ? { section } : {}), chars: passage.text.length, excerpt: "" };
  });
  const size = (list: unknown) => JSON.stringify(list).length;
  if (size(bare) > OUTLINE_PROMPT_CHARS) return null;
  let share = Math.floor((OUTLINE_PROMPT_CHARS - size(bare)) / Math.max(1, passages.length));
  for (;;) {
    const list = bare.map((entry, index) => ({ ...entry, excerpt: excerpt(passages[index]!.text, share) }));
    // JSON escapes can make an excerpt longer than its characters, so the share shrinks until the list fits.
    if (size(list) <= OUTLINE_PROMPT_CHARS || share === 0) return { topic, parts: bounds, passages: list };
    share = Math.floor(share * 0.9);
  }
}

export type OutlinePart = {
  id: string;
  position: number;
  kind: "part" | "recap";
  title: string;
  about: string;
  passageIds: string[];
  minutes: number;
  itemId: string | null;
  summary: string | null;
  doneAt: number | null;
};

export type Outline = {
  id: string;
  planId: string;
  topicId: string;
  origin: "model" | "fallback" | "single";
  wording: string | null;
  replacesItemId: string | null;
  passageKey: string;
  createdAt: number;
  /** In reading order, the recap last. */
  parts: OutlinePart[];
};

/** The SHA-256 of a topic's sorted passage ids, so a later rebuild that changes the material can be noticed. */
export function passageKey(passageIds: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...passageIds].sort()))
    .digest("hex");
}

/** A topic's live outline, found through the partial unique index `lesson_outlines_live`. */
export const LIVE_OUTLINE_SQL = `SELECT id, plan_id AS planId, topic_id AS topicId, origin, wording,
  replaces_item_id AS replacesItemId, passage_key AS passageKey, created_at AS createdAt
  FROM lesson_outlines WHERE topic_id = ? AND retired_at IS NULL`;

/** The part a lesson item is, found through `lesson_parts_item`. */
export const PART_OF_ITEM_SQL = `SELECT id AS partId, outline_id AS outlineId, position, kind
  FROM lesson_parts WHERE item_id = ?`;

/** The live outline of a topic with its parts, or null when the topic has none yet. */
export function liveOutline(db: Database.Database, topicId: string): Outline | null {
  const row = db.prepare(LIVE_OUTLINE_SQL).get(topicId) as Omit<Outline, "parts"> | undefined;
  if (!row) return null;
  const parts = db
    .prepare(
      `SELECT id, position, kind, title, about, passage_ids_json, minutes, item_id, summary, done_at
       FROM lesson_parts WHERE outline_id = ? ORDER BY position`,
    )
    .all(row.id) as Array<{
    id: string;
    position: number;
    kind: "part" | "recap";
    title: string;
    about: string;
    passage_ids_json: string;
    minutes: number;
    item_id: string | null;
    summary: string | null;
    done_at: number | null;
  }>;
  return {
    ...row,
    parts: parts.map((part) => ({
      id: part.id,
      position: part.position,
      kind: part.kind,
      title: part.title,
      about: part.about,
      passageIds: JSON.parse(part.passage_ids_json) as string[],
      minutes: part.minutes,
      itemId: part.item_id,
      summary: part.summary,
      doneAt: part.done_at,
    })),
  };
}

/** Which part a lesson item is, or null for a lesson that is not a part. */
export function partOfItem(
  db: Database.Database,
  itemId: string,
): { partId: string; outlineId: string; position: number; kind: "part" | "recap" } | null {
  return (
    (db.prepare(PART_OF_ITEM_SQL).get(itemId) as
      | { partId: string; outlineId: string; position: number; kind: "part" | "recap" }
      | undefined) ?? null
  );
}

type Plan = {
  origin: Outline["origin"];
  parts: PlannedPart[];
  engine?: { provider: string; model: string };
};

/**
 * Saves an outline unless the topic got a live one meanwhile, and returns the topic's live outline. Teaching parts
 * get their estimated minutes; from `RECAP_FROM` teaching parts on, the recap follows them. Only a model's cut carries
 * engine and prompt provenance: the fallback and a one-part topic are cut by code.
 */
function saveOutline(
  db: Database.Database,
  input: { planId: string; topicId: string },
  passages: readonly OutlinePassage[],
  plan: Plan,
  language: string,
): Outline {
  const chars = new Map(passages.map((passage) => [passage.id, passage.text.length]));
  const rows: Array<PlannedPart & Pick<OutlinePart, "kind" | "minutes">> = plan.parts.map((part) => ({
    ...part,
    kind: "part",
    minutes: estimateMinutes(part.passageIds.reduce((sum, id) => sum + (chars.get(id) ?? 0), 0)),
  }));
  if (rows.length >= RECAP_FROM)
    rows.push({ kind: "recap", title: recapTitle(language), about: "", passageIds: [], minutes: RECAP_MINUTES });
  const prompt = plan.engine ? promptProvenance("lesson.outline") : null;
  const now = Date.now();
  db.transaction(() => {
    if (db.prepare(LIVE_OUTLINE_SQL).get(input.topicId)) return;
    const id = uuidv7(now);
    db.prepare(
      `INSERT INTO lesson_outlines (id, plan_id, topic_id, passage_key, origin, engine_provider, model_id, model_source,
         prompt_template, prompt_version, grounding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.planId,
      input.topicId,
      passageKey(passages.map((passage) => passage.id)),
      plan.origin,
      plan.engine?.provider ?? null,
      plan.engine?.model ?? null,
      plan.engine ? "reported" : null,
      prompt?.template ?? null,
      prompt?.version ?? null,
      passages.length > 0 ? "sources" : "general",
      now,
    );
    const insert = db.prepare(
      `INSERT INTO lesson_parts (id, outline_id, position, kind, title, about, passage_ids_json, minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((row, index) =>
      insert.run(uuidv7(now), id, index + 1, row.kind, row.title, row.about, JSON.stringify(row.passageIds), row.minutes),
    );
  })();
  return liveOutline(db, input.topicId)!;
}

export type PlanPartsInput = {
  planId: string;
  topicId: string;
  selection?: GenerateInput["selection"];
  run?: GenerateInput["run"];
  signal?: AbortSignal;
};

/**
 * Makes a topic's outline when it has no live one, and returns the live outline. A topic of one part is saved with no
 * call (`origin = 'single'`, the topic's title). Otherwise the model plans the parts from the passage list; a reply
 * `checkOutline` rejects is asked again once with its problems, and a second rejection, a reply the schema repair could
 * not fix, or a passage list too long to send is cut by `fallbackOutline` (`origin = 'fallback'`). An engine error or a
 * cancel saves nothing and is thrown, so the next open tries again.
 */
export async function planParts(db: Database.Database, input: PlanPartsInput): Promise<Outline> {
  requireTopic(db, input.planId, input.topicId);
  const existing = liveOutline(db, input.topicId);
  if (existing) return existing;
  const topic = db.prepare("SELECT title FROM topics WHERE id = ?").get(input.topicId) as { title: string };
  const passages = outlinePassages(db, input.topicId);
  const language = planLanguage(db, input.planId);
  const passageIds = passages.map((passage) => passage.id);
  const chars = passages.reduce((sum, passage) => sum + passage.text.length, 0);
  const bounds = partBounds(chars, passages.length);
  if (!bounds)
    return saveOutline(db, input, passages, { origin: "single", parts: [{ title: topic.title, about: "", passageIds }] }, language);
  const fallback = () =>
    saveOutline(db, input, passages, { origin: "fallback", parts: fallbackOutline(passages, bounds.target, language) }, language);
  const request = outlineRequest(topic.title, passages, bounds);
  if (!request) return fallback();
  const selection = input.selection ?? selectionFor(db, "lesson");
  const system = systemPrompt("lesson.outline", { contentLanguage: language });
  let problems: string[] = [];
  for (let ask = 0; ask < 2; ask++) {
    let result: Awaited<ReturnType<typeof generate>>;
    try {
      result = await generate({
        selection,
        run: input.run,
        signal: input.signal,
        schema: outlineReply,
        system,
        // The problems travel inside the JSON, which the recorded engine and the structured providers read as it is.
        prompt: JSON.stringify(problems.length > 0 ? { ...request, problems } : request),
      });
    } catch (error) {
      if (error instanceof IpcError && error.code === "invalid-output") return fallback();
      throw error;
    }
    input.signal?.throwIfAborted();
    const checked = checkOutline(result.data as OutlineReply, passageIds, bounds);
    if (checked.ok)
      return saveOutline(
        db,
        input,
        passages,
        { origin: "model", parts: checked.parts, engine: { provider: result.provider, model: result.model } },
        language,
      );
    problems = checked.problems;
  }
  return fallback();
}

// Writing one part. Each call gets the whole outline, the headings and summary of every part already written and only
// this part's passages, so no two calls teach from the same material and each knows what the others cover. The reply's
// shape is checked by code (`partShape`) before anything is saved.

/** Teaching sections a part must have, and the recap's one. */
export const PART_SECTIONS = { min: 2, max: 3 } as const;
/** Words of a teaching part. The prompt asks for at most 1,200; the check leaves some room above that. */
export const PART_WORDS = { min: 250, max: 1_400 } as const;
/** What a second reply may still be: sections and words a page can show, though off the shape asked for. */
export const LENIENT_SECTIONS = { min: 1, max: 4 } as const;
export const LENIENT_WORDS = 2_000;
/** Longest takeaway, which becomes the part's two-line summary. */
export const SUMMARY_CHARS = 300;
/** Questions of the recap part's closing pyxis-recap. */
export const RECAP_QUESTIONS = 3;
/** A written part's minutes: its words at this pace, plus one for the question, kept in bounds. */
export const WORDS_PER_MINUTE = 200;
export const PART_MIN_MINUTES = 2;
export const PART_MAX_MINUTES = 12;
/** Room kept in the request for the problems of a second ask, so both asks stay within `CONTEXT_CHARS`. */
const PROBLEMS_CHARS = 1_000;
/** Longest source heading in a part's material: a heading is a label, and a longer one is cut. */
export const MATERIAL_HEADING_CHARS = 200;
/** A heading as the request lists it for a written part. */
const HEADING_CHARS = 120;
/** The topic's title and a part's line on what it teaches, as the request lists them. */
const TOPIC_CHARS = 200;
const ABOUT_CHARS = 200;

/** The plan's word for a part with its number, such as "Parte 3", for job titles. */
export function partLabel(language: string, position: number): string {
  return partName(language, position);
}

/** A heading as two headings are compared: case, accents, punctuation and spaces ignored. */
export function foldHeading(heading: string): string {
  return heading
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Words of a text as the reader counts them: runs of characters between spaces that hold a letter or a digit. */
function wordsOf(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The words a part shows before any answer: its prose, and the visible text of each block. */
export function partWords(markdown: string): number {
  return parseSmartText(markdown).reduce((sum, segment) => {
    if (segment.type === "markdown") return sum + wordsOf(segment.text);
    if (segment.type !== "block") return sum;
    const { block } = segment;
    const shown =
      block.kind === "check"
        ? [block.question, ...block.options]
        : block.kind === "recap"
          ? block.questions.flatMap((question) => [question.question, ...question.options])
          : block.kind === "try"
            ? [block.prompt]
            : block.kind === "reveal"
              ? [block.front]
              : block.kind === "example"
                ? [block.title ?? "", block.body]
                : [block.caption];
    return sum + shown.reduce((words, text) => words + wordsOf(text), 0);
  }, 0);
}

/** A written part's minutes from its words. */
export function partMinutes(words: number): number {
  return clamp(Math.ceil(words / WORDS_PER_MINUTE) + 1, PART_MIN_MINUTES, PART_MAX_MINUTES);
}

export type PartShapeContext = {
  kind: OutlinePart["kind"];
  /** The ## headings of the other written parts of the outline. */
  headings: readonly string[];
  /** The second reply: accept what a page can show instead of asking again. */
  last: boolean;
};

export type PartShape =
  | {
      ok: true;
      markdown: string;
      /** The takeaway, or null when the reply had none. */
      summary: string | null;
      words: number;
      /** Whether the part ends with its question: a pyxis-check, or the recap's pyxis-recap. */
      question: boolean;
    }
  | { ok: false; problems: string[] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

/** The fenced blocks of a text by line range (`to` is the closing line), as `parseSmartText` finds them. */
function fencedBlocks(lines: readonly string[]): Array<{ info: string; from: number; to: number; body: string }> {
  const blocks: Array<{ info: string; from: number; to: number; body: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const fence = open[1]!;
    let close = i + 1;
    while (close < lines.length) {
      const line = lines[close]!.trim();
      if (/^[`~]+$/.test(line) && line[0] === fence[0] && line.length >= fence.length) break;
      close++;
    }
    const to = Math.min(close, lines.length - 1);
    blocks.push({ info: open[2]!.toLowerCase(), from: i, to, body: lines.slice(i + 1, close).join("\n") });
    i = to;
  }
  return blocks;
}

/** A takeaway block's text: `{"text": ...}`, or a body that is only a string. */
function takeawayText(body: string): string | null {
  const raw = parseLooseJson(body);
  const text =
    typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as { text?: unknown }).text : undefined;
  return typeof text === "string" && text.trim() ? text.replace(/\s+/g, " ").trim() : null;
}

/** A summary cut to `SUMMARY_CHARS` at a word, for a second reply whose takeaway is too long. */
function cutSummary(text: string): string {
  if (text.length <= SUMMARY_CHARS) return text;
  const cut = text.slice(0, SUMMARY_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUMMARY_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Checks a part's reply before it is saved, and repairs what it can. Always repaired: the whole reply in one fence, a
 * leading # title (removed), recap blocks in a teaching part and checks in the recap part (removed), every question
 * block but the last one that parses (removed), and the pyxis-takeaway, which leaves the text and becomes the summary.
 * Rejected, with one line per broken rule for the second ask: the wrong number of ## sections (2 or 3, the recap 1), a
 * part that does not end with its question (a pyxis-check, or a pyxis-recap of 3 questions), a teaching part under 250
 * or any part over 1,400 words, a heading another written part already has (case, accents and punctuation ignored), and
 * a missing takeaway or one over 300 characters. The second reply (`last`) is accepted when it has 1 to 4 sections and
 * at most 2,000 words, with or without its question; its takeaway is cut to 300 characters.
 */
export function partShape(reply: string, context: PartShapeContext): PartShape {
  const lines = lessonText(reply).replace(/\r\n?/g, "\n").split("\n");
  const blocks = fencedBlocks(lines);
  const asked = context.kind === "recap" ? "pyxis-recap" : "pyxis-check";
  const other = context.kind === "recap" ? "pyxis-check" : "pyxis-recap";
  const drop = new Set<number>();
  const remove = (from: number, to: number) => {
    for (let line = from; line <= to; line++) drop.add(line);
    // The blank lines after a removed block go with it, so no gap is left.
    for (let line = to + 1; line < lines.length && !lines[line]!.trim(); line++) drop.add(line);
  };
  let summary: string | null = null;
  for (const block of blocks) {
    if (block.info === "pyxis-takeaway") {
      summary = takeawayText(block.body) ?? summary;
      remove(block.from, block.to);
    } else if (block.info === other) remove(block.from, block.to);
  }
  const questions = blocks.filter(
    (block) =>
      block.info === asked &&
      parseSmartText(lines.slice(block.from, block.to + 1).join("\n")).some((segment) => segment.type === "block"),
  );
  for (const block of blocks)
    if (block.info === asked && block !== questions.at(-1)) remove(block.from, block.to);
  const first = lines.findIndex((line, index) => !drop.has(index) && line.trim() !== "");
  if (first >= 0 && /^ {0,3}#(?!#)\s/.test(lines[first]!)) remove(first, first);
  const markdown = lines
    .filter((_, index) => !drop.has(index))
    .join("\n")
    .trim();

  const segments = parseSmartText(markdown);
  const last = segments.at(-1);
  const ends =
    last?.type === "block" &&
    (context.kind === "recap"
      ? last.block.kind === "recap" && last.block.questions.length === RECAP_QUESTIONS
      : last.block.kind === "check");
  const question = segments.some(
    (segment) => segment.type === "block" && segment.block.kind === (context.kind === "recap" ? "recap" : "check"),
  );
  const sections = smartSections(markdown);
  const words = partWords(markdown);

  if (context.last) {
    if (!markdown || sections.length < LENIENT_SECTIONS.min || sections.length > LENIENT_SECTIONS.max || words > LENIENT_WORDS)
      return { ok: false, problems: [`The reply has ${sections.length} sections and ${words} words.`] };
    return { ok: true, markdown, summary: summary === null ? null : cutSummary(summary), words, question };
  }

  const problems: string[] = [];
  const wanted = context.kind === "recap" ? { min: 1, max: 1 } : PART_SECTIONS;
  if (sections.length < wanted.min || sections.length > wanted.max)
    problems.push(
      `The part has ${sections.length} ## sections. Write ${
        wanted.min === wanted.max ? `exactly ${wanted.min}` : `${wanted.min} or ${wanted.max}`
      }.`,
    );
  if (!ends)
    problems.push(
      context.kind === "recap"
        ? `The recap part does not end with one pyxis-recap of ${RECAP_QUESTIONS} questions. End it with that block, then the pyxis-takeaway.`
        : "The part does not end with one pyxis-check. End it with exactly one pyxis-check, then the pyxis-takeaway.",
    );
  if (words > PART_WORDS.max || (context.kind === "part" && words < PART_WORDS.min))
    problems.push(`The part has ${words} words. Write between ${PART_WORDS.min} and 1,200.`);
  const taken = new Set(context.headings.map(foldHeading));
  for (const section of sections)
    if (taken.has(foldHeading(section.title)))
      problems.push(
        `The section "${section.title}" has the heading of a section of another part. Teach this part's own step, under a heading of its own.`,
      );
  if (summary === null) problems.push('The pyxis-takeaway block is missing. End the part with {"text": "..."} in it.');
  else if (summary.length > SUMMARY_CHARS)
    problems.push(`The pyxis-takeaway has ${summary.length} characters. Keep it within ${SUMMARY_CHARS}, in two sentences.`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, markdown, summary, words, question };
}

/** The ## headings of a saved lesson item, in order. */
function itemHeadings(db: Database.Database, itemId: string): string[] {
  const markdown = db
    .prepare("SELECT json_extract(body_json, '$.markdown') FROM items WHERE id = ?")
    .pluck()
    .get(itemId) as string | null | undefined;
  return markdown ? smartSections(markdown).map((section) => section.title) : [];
}

/** Text cut to at most `chars` characters, with an ellipsis when it was longer. */
function cutText(text: string, chars: number): string {
  const all = Array.from(text);
  return all.length <= chars ? text : `${all.slice(0, Math.max(0, chars - 1)).join("").trimEnd()}…`;
}

/**
 * Material cut so that it fits in `budget` characters. Headings are labels: each is cut to `MATERIAL_HEADING_CHARS`.
 * When the material is still too long, every passage gets an equal share of the budget: its heading at most a quarter
 * of it (none when the share is too small to name it), and its own text the rest, so every passage keeps some text.
 */
function fittedMaterial(passages: readonly OutlinePassage[], budget: number): string {
  const rows = passages.map((passage) => ({
    text: passage.text,
    section_path: passage.section && cutText(passage.section, MATERIAL_HEADING_CHARS),
  }));
  const whole = materialText(rows);
  if (whole.length <= budget) return whole;
  const share = Math.floor(Math.max(0, budget) / Math.max(1, rows.length));
  const label = share >= 80 ? Math.min(MATERIAL_HEADING_CHARS, Math.floor(share / 4)) : 0;
  return materialText(
    rows.map((row) => {
      const section_path = row.section_path && label > 0 ? cutText(row.section_path, label) : null;
      // "### " and the blank line after a heading, and the blank line before the next passage.
      const frame = (section_path ? section_path.length + 6 : 0) + 2;
      return { section_path, text: row.text.slice(0, Math.max(0, share - frame)) };
    }),
  );
}

export type PartRequestInput = {
  topic: string;
  outline: Outline;
  part: OutlinePart;
  /** The headings of each written part, by position. */
  headings: ReadonlyMap<number, readonly string[]>;
  /** This part's passages, in reading order; the recap has none. */
  passages: readonly OutlinePassage[];
};

/**
 * The request for one part, as Markdown: the topic and the part's place, the whole outline, what the other written
 * parts teach (their headings and summary) and only this part's material. The whole request stays within
 * `CONTEXT_CHARS`, with room for the problems of a second ask: the material gets what the rest leaves.
 */
export function partRequest(input: PartRequestInput): string {
  const { outline, part } = input;
  const teaching = outline.parts.filter((entry) => entry.kind === "part").length;
  const place =
    part.kind === "recap"
      ? `This is the recap part, after the ${teaching} parts: recap the whole topic from what the parts teach.`
      : `Part ${part.position} of ${teaching}.`;
  const plan = outline.parts
    .map((entry) => {
      const marks = [
        entry.position === part.position ? "this part" : "",
        entry.itemId && entry.position !== part.position ? "written" : "",
        entry.kind === "recap" ? "recap" : "",
      ].filter(Boolean);
      const about = entry.about ? `: ${cutText(entry.about, ABOUT_CHARS)}` : "";
      return `${entry.position}. ${cutText(entry.title, TITLE_CHARS)}${about}${marks.length ? ` (${marks.join(", ")})` : ""}`;
    })
    .join("\n");
  const written = outline.parts
    .filter((entry) => entry.itemId && entry.position !== part.position)
    .map((entry) => {
      const headings = (input.headings.get(entry.position) ?? []).map(
        (heading) => `"${cutText(heading, HEADING_CHARS)}"`,
      );
      const when = entry.position < part.position ? "before this part" : "after this part";
      const lines = [
        `Part ${entry.position}, ${cutText(entry.title, TITLE_CHARS)} (${when}). Sections: ${headings.slice(0, LENIENT_SECTIONS.max).join(", ") || "none"}.`,
      ];
      if (entry.summary) lines.push(`What it taught: ${cutText(entry.summary, SUMMARY_CHARS)}`);
      return lines.join("\n");
    });
  const head = [
    `Topic: ${cutText(input.topic, TOPIC_CHARS)}`,
    place,
    `The lesson's parts:\n${plan}`,
    written.length ? `Parts already written:\n\n${written.join("\n\n")}` : "No part is written yet.",
  ].join("\n\n");
  if (part.kind === "recap" || input.passages.length === 0) return head;
  const label = "\n\nMaterial of this part:\n\n";
  const bound = CONTEXT_CHARS - PROBLEMS_CHARS;
  let budget = bound - head.length - label.length;
  let request = `${head}${label}${fittedMaterial(input.passages, budget)}`;
  // The size is measured, not trusted: a request still over the bound is fitted again with less room for material.
  for (let round = 0; request.length > bound && round < 3; round++) {
    budget -= request.length - bound;
    request = `${head}${label}${fittedMaterial(input.passages, budget)}`;
  }
  return request;
}

/** The second ask: the same request with the problems of the first reply. */
export function partRetry(request: string, problems: readonly string[]): string {
  const list = problems.map((problem) => `- ${problem}`).join("\n");
  return `${request}\n\nProblems with your previous reply:\n${Array.from(list).slice(0, PROBLEMS_CHARS - 40).join("")}`;
}

export type WritePartInput = {
  planId: string;
  topicId: string;
  position: number;
  wording?: Wording;
  selection?: GenerateInput["selection"];
  run?: GenerateInput["run"];
  signal?: AbortSignal;
  /** Runs figure code, as for `writeLesson`; null turns figures off. */
  python?: FigureRunner | null;
};

const PART_VERSION = templateVersion("lesson.part");

/**
 * Writes the part at `position` of the topic's live outline and returns the outline with it, or returns the outline as
 * it is when that part is already written. One call, and one more with the problems when `partShape` rejects the
 * reply; a second reply it cannot accept fails with `lesson-part-invalid`. The part is saved as a lesson item (template
 * `lesson.part`, the part's id in its cache key) together with the part's item, summary and measured minutes, in one
 * transaction once figures are drawn, so an engine error, a cancel or a quit before that leaves nothing of it.
 */
export async function writePart(db: Database.Database, input: WritePartInput): Promise<Outline> {
  requireTopic(db, input.planId, input.topicId);
  const outline = liveOutline(db, input.topicId);
  const part = outline?.parts.find((entry) => entry.position === input.position);
  if (!outline || !part) throw new Error("part-missing");
  if (part.itemId) return outline;
  const stored = wordings.find((wording) => wording === outline.wording);
  const context = modelContext(db, input.planId, input.topicId, input.wording ?? stored);
  const topic = db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(input.topicId) as string;
  // Passages that left the topic since it was planned are not taught.
  const own = new Set(part.passageIds);
  const passages = part.kind === "recap" ? [] : outlinePassages(db, input.topicId).filter((passage) => own.has(passage.id));
  const grounded =
    part.kind === "recap" ? outline.parts.some((entry) => entry.passageIds.length > 0) : passages.length > 0;
  const headings = new Map(
    outline.parts.flatMap((entry) =>
      entry.itemId && entry.position !== part.position ? [[entry.position, itemHeadings(db, entry.itemId)] as const] : [],
    ),
  );
  const request = partRequest({ topic, outline, part, headings, passages });
  const python = await figureRunner(input.python);
  const system = [lessonSystem(context, grounded, python != null, "lesson.part"), interestsLine(db)]
    .filter(Boolean)
    .join("\n");
  const selection = input.selection ?? selectionFor(db, "lesson");
  let problems: string[] = [];
  let shaped: Extract<PartShape, { ok: true }> | null = null;
  let engine: { provider: string; model: string } | null = null;
  for (let ask = 0; ask < 2 && !shaped; ask++) {
    const prompt = problems.length > 0 ? partRetry(request, problems) : request;
    // Every bound above keeps a request within this; a request over it is a bug, and no call is made.
    if (prompt.length > CONTEXT_CHARS) throw new Error("lesson-part-too-long");
    const result = await generate({
      selection,
      run: input.run,
      signal: input.signal,
      system,
      prompt,
    });
    input.signal?.throwIfAborted();
    const checked = partShape(result.text, {
      kind: part.kind,
      headings: [...headings.values()].flat(),
      last: ask === 1,
    });
    if (checked.ok) {
      shaped = checked;
      engine = { provider: result.provider, model: result.model };
    } else problems = checked.problems;
  }
  if (!shaped || !engine) throw new Error("lesson-part-invalid");
  const { markdown, figures } = await withFigures(shaped.markdown, python, { signal: input.signal });
  input.signal?.throwIfAborted();
  const passageIds = passages.map((passage) => passage.id);
  const summary = shaped.summary ?? (part.about || null);
  const minutes = partMinutes(shaped.words);
  db.transaction(() => {
    // The outline may have been retired, or the part written by another job, while this one waited for the engine.
    const current = db
      .prepare(
        `SELECT p.item_id FROM lesson_parts p JOIN lesson_outlines o ON o.id = p.outline_id
         WHERE p.id = ? AND o.retired_at IS NULL`,
      )
      .get(part.id) as { item_id: string | null } | undefined;
    if (!current || current.item_id) return;
    const itemId = saveLesson(db, {
      planId: input.planId,
      topicId: input.topicId,
      kind: "lesson",
      key: cacheKey({
        kind: "lesson",
        scopeId: part.id,
        passageIds,
        promptVersion: [PART_VERSION, context.wording, context.education, context.school, context.course, context.language].join("|"),
      }),
      markdown,
      passageIds,
      engine,
      prompt: promptProvenance("lesson.part"),
      grounding: grounded ? "sources" : "general",
      figures,
    });
    db.prepare("UPDATE lesson_parts SET item_id = ?, summary = ?, minutes = ? WHERE id = ?").run(
      itemId,
      summary,
      minutes,
      part.id,
    );
  })();
  return liveOutline(db, input.topicId) ?? outline;
}

/**
 * The written parts of a topic's live outline joined in reading order, for export: each under its title as a ##
 * heading, its own headings one level down, or a one-part topic's text as it is. The passages are the ones the saved
 * parts were written from, which leave out material removed between planning and writing. Null when no part is written.
 */
export function partsMarkdown(db: Database.Database, topicId: string): { markdown: string; passageIds: string[] } | null {
  const outline = liveOutline(db, topicId);
  const written = outline?.parts.filter((part) => part.itemId) ?? [];
  if (!outline || written.length === 0) return null;
  const read = db.prepare("SELECT json_extract(body_json, '$.markdown') AS markdown FROM items WHERE id = ?").pluck();
  const cited = db
    .prepare(
      `SELECT ip.passage_id FROM item_passages ip JOIN passages p ON p.id = ip.passage_id
       WHERE ip.item_id = ? ORDER BY p.created_at, p.id`,
    )
    .pluck();
  const single = outline.parts.length === 1;
  const texts: string[] = [];
  const passageIds = new Set<string>();
  for (const part of written) {
    const markdown = read.get(part.itemId) as string | null | undefined;
    if (!markdown) continue;
    texts.push(single ? markdown : `## ${part.title}\n\n${demoteHeadings(markdown)}`);
    for (const id of cited.all(part.itemId) as string[]) passageIds.add(id);
  }
  if (texts.length === 0) return null;
  return { markdown: texts.join("\n\n"), passageIds: [...passageIds] };
}

/** Every Markdown heading outside code one level down, so a part's sections sit under the part's title. */
function demoteHeadings(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker;
        else if (line.trim()[0] === fence[0] && line.trim().length >= fence.length && /^[`~]+$/.test(line.trim()))
          fence = null;
        return line;
      }
      return !fence && /^#{1,5}\s/.test(line) ? `#${line}` : line;
    })
    .join("\n");
}
