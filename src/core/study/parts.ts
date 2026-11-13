import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";
import { generate, type GenerateInput } from "../engine/generate";
import { planLanguage, promptProvenance, systemPrompt } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { CONTEXT_CHARS, requireTopic } from "./openLesson";

// A topic's lesson in short parts: how many parts, the plan of them (the outline) and its checks. Writing a part and the
// job that does it come later; this module only plans and reads.

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
/** The planning request, as it is sent, stays within the bound every lesson call has. */
export const OUTLINE_PROMPT_CHARS = CONTEXT_CHARS;
/**
 * Longest topic title, file title or heading in the planning request. They are labels, and a long one must not crowd
 * the passages out of the request or make planning skip the model.
 */
export const OUTLINE_LABEL_CHARS = 200;
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
 * are the topic's passages in reading order, labelled P1, P2 and so on in the call.
 *
 * A part may gather passages that are apart. A topic often holds several files on the same subjects (a book chapter,
 * then the course slides on that chapter), and parts cut only from runs of neighbouring passages would teach the
 * slides' subjects again after the book's. So what an accepted outline holds is: every passage in exactly one part,
 * each part's passages in reading order, and the parts ordered by their first passage, where their subject first
 * appears.
 *
 * Repairs: an unknown label is dropped; a passage in two parts stays in the first part that lists it; a part's passages
 * are sorted into reading order and the parts by their first passage; a part left with no passage is dropped; a passage
 * in no part joins the part of the nearest earlier passage, or the first part. Rejections: fewer than `min` or more than
 * `max` parts after the repairs, and an empty or repeated title.
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

/**
 * A passage as planning reads it: `section` is its heading, or null when it has none worth naming, and `fileId` and
 * `file` are the source it comes from and that source's title.
 */
export type OutlinePassage = {
  id: string;
  text: string;
  section: string | null;
  fileId: string | null;
  file: string | null;
};

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
 * Cuts a topic into at most `count` parts without a model. Unlike a model's outline, each part is a run of neighbouring
 * passages, because code cannot tell which passages of two files treat the same subject. It walks the passages in
 * reading order and closes a part once it holds its share of what is left, never splitting a passage and never leaving
 * a part empty. Within
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
      `SELECT p.id, p.text, p.section_path, p.locator_json, p.source_id, s.title
       FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id LEFT JOIN sources s ON s.id = p.source_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at, p.id`,
    )
    .all(topicId) as Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string | null;
    source_id: string | null;
    title: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    section: passageSection(row.section_path, row.locator_json),
    fileId: row.source_id,
    file: row.title,
  }));
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
  passages: Array<{ label: string; file?: string; section?: string; chars: number; excerpt: string }>;
  problems?: string[];
};

/** A label cut to `OUTLINE_LABEL_CHARS` characters, the last of them an ellipsis when it was longer. */
function labelText(text: string): string {
  const chars = Array.from(text);
  return chars.length <= OUTLINE_LABEL_CHARS ? text : `${chars.slice(0, OUTLINE_LABEL_CHARS - 1).join("")}…`;
}

/**
 * The planning call's input, `problems` included on the second ask. Each passage is listed by its label, its file's
 * title when the file changes, its heading when it starts a new one (a new file starts its headings afresh), its length
 * and its first characters. The file and the heading are what let the model gather the passages of two files on the
 * same subject. Titles and headings are cut to `OUTLINE_LABEL_CHARS`, and the excerpts to an equal share, so the whole
 * request as it is sent stays within `OUTLINE_PROMPT_CHARS`. Null when it does not fit even with no excerpts: the
 * topic is then cut by the fallback without a call.
 */
export function outlineRequest(
  topic: string,
  passages: readonly OutlinePassage[],
  bounds: PartBounds,
  problems: readonly string[] = [],
): OutlineRequest | null {
  let heading: string | null = null;
  const bare = passages.map((passage, index) => {
    const newFile = index === 0 || passage.fileId !== passages[index - 1]!.fileId;
    if (newFile) heading = null;
    const section = passage.section !== null && passage.section !== heading ? passage.section : undefined;
    heading = passage.section ?? heading;
    return {
      label: `P${index + 1}`,
      ...(newFile && passage.file ? { file: labelText(passage.file) } : {}),
      ...(section ? { section: labelText(section) } : {}),
      chars: passage.text.length,
      excerpt: "",
    };
  });
  const request = (list: OutlineRequest["passages"]): OutlineRequest => ({
    topic: labelText(topic),
    parts: bounds,
    passages: list,
    ...(problems.length > 0 ? { problems: [...problems] } : {}),
  });
  const size = (list: OutlineRequest["passages"]) => JSON.stringify(request(list)).length;
  if (size(bare) > OUTLINE_PROMPT_CHARS) return null;
  let share = Math.floor((OUTLINE_PROMPT_CHARS - size(bare)) / Math.max(1, passages.length));
  for (;;) {
    const list = bare.map((entry, index) => ({ ...entry, excerpt: excerpt(passages[index]!.text, share) }));
    // JSON escapes can make an excerpt longer than its characters, so the share shrinks until the request fits.
    if (size(list) <= OUTLINE_PROMPT_CHARS || share === 0) return request(list);
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
  /** When the part's last write failed or was cancelled; null once a write succeeds. */
  writeFailedAt: number | null;
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
      `SELECT id, position, kind, title, about, passage_ids_json, minutes, item_id, summary, done_at, write_failed_at
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
    write_failed_at: number | null;
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
      writeFailedAt: part.write_failed_at,
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
 * Saves an outline unless the topic got a live one meanwhile, and returns the topic's live outline. A cancelled call
 * saves nothing and throws the abort, whichever way the outline was made. Teaching parts
 * get their estimated minutes; from `RECAP_FROM` teaching parts on, the recap follows them. Only a model's cut carries
 * engine and prompt provenance: the fallback and a one-part topic are cut by code.
 */
function saveOutline(
  db: Database.Database,
  input: { planId: string; topicId: string; signal?: AbortSignal },
  passages: readonly OutlinePassage[],
  plan: Plan,
  language: string,
): Outline {
  input.signal?.throwIfAborted();
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
 * not fix, or a request over `OUTLINE_PROMPT_CHARS` even with no excerpts, on either ask, is cut by `fallbackOutline`
 * (`origin = 'fallback'`). No call goes out above that bound. An engine error or a cancel saves nothing and is thrown,
 * so the next open tries again.
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
  let selection = input.selection;
  const system = systemPrompt("lesson.outline", { contentLanguage: language });
  let problems: string[] = [];
  for (let ask = 0; ask < 2; ask++) {
    // Built for each ask, so the second, with its problems, is measured against the bound as it is sent too.
    const request = outlineRequest(topic.title, passages, bounds, problems);
    if (!request) return fallback();
    selection ??= selectionFor(db, "lesson");
    let result: Awaited<ReturnType<typeof generate>>;
    try {
      result = await generate({
        selection,
        run: input.run,
        signal: input.signal,
        schema: outlineReply,
        system,
        // The problems travel inside the JSON, which the recorded engine and the structured providers read as it is.
        prompt: JSON.stringify(request),
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
