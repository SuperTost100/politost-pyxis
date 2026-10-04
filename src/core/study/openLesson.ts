import type Database from "better-sqlite3";
import { generate } from "../engine/generate";
import { planLanguage, systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { cacheKey, loadLesson, saveLesson } from "./lesson";
import { IpcError } from "../../shared/ipc";

const BOOK_VERSION = "book-1";
// Part of the lesson cache key; comes from the template front matter.
const MODEL_VERSION = templateVersion("lesson.write");

export const wordings = ["simple", "balanced", "technical"] as const;
export type Wording = (typeof wordings)[number];

// ponytail: one bounded call (first passages in reading order); a long topic is summarised from its opening, not chunked.
const CONTEXT_CHARS = 24_000;
const PASSAGE_CHARS = 4_000;

const WORDING_RULES: Record<Wording, string> = {
  simple:
    "Use short sentences, everyday words and one concrete example; define each term the first time you use it.",
  balanced:
    "Use clear standard wording; explain terms briefly and stay close to the level of the passages.",
  technical:
    "Use precise terminology and formal notation; assume the reader already knows the basics.",
};

type Passage = { id: string; text: string; section_path: string | null };

function passagesFor(db: Database.Database, topicId: string): Passage[] {
  return db
    .prepare(
      `SELECT p.id, p.text, p.section_path
       FROM topic_passages tp
       JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at, p.id`,
    )
    .all(topicId) as Passage[];
}

function boundedPassages(all: Passage[]): Passage[] {
  const used: Passage[] = [];
  let size = 0;
  for (const row of all) {
    const text = row.text.slice(0, PASSAGE_CHARS);
    if (used.length && size + text.length > CONTEXT_CHARS) break;
    used.push({ ...row, text });
    size += text.length;
  }
  return used;
}

function bookMarkdown(passages: Array<Pick<Passage, "text" | "section_path">>) {
  return passages
    .map((row) => {
      const heading = row.section_path ? `## ${row.section_path}\n\n` : "";
      return `${heading}${row.text}`;
    })
    .join("\n\n");
}

export function requireTopic(
  db: Database.Database,
  planId: string,
  topicId: string,
) {
  const row = db
    .prepare(`SELECT id FROM topics WHERE id = ? AND plan_id = ?`)
    .get(topicId, planId) as { id: string } | undefined;
  if (!row) throw new Error("topic-missing");
}

/** Everything that decides which model lesson is cached: topic passages sent, wording, education level and language. */
function modelContext(
  db: Database.Database,
  planId: string,
  topicId: string,
  requested?: Wording,
) {
  requireTopic(db, planId, topicId);
  const all = passagesFor(db, topicId);
  const used = boundedPassages(all);
  const profile = db
    .prepare("SELECT education_level, wording_level FROM profile LIMIT 1")
    .get() as
    | { education_level: string | null; wording_level: string | null }
    | undefined;
  const stored = wordings.find((item) => item === profile?.wording_level);
  const wording = requested ?? stored ?? "balanced";
  const education = profile?.education_level?.trim() || "university";
  const language = planLanguage(db, planId);
  const passageIds = used.map((row) => row.id);
  const key = cacheKey({
    kind: "lesson",
    scopeId: topicId,
    passageIds,
    promptVersion: [MODEL_VERSION, wording, education, language].join("|"),
  });
  return { all, used, passageIds, wording, education, language, key };
}

function lessonSystem(
  context: ReturnType<typeof modelContext>,
  grounded: boolean,
) {
  const style = `Reader education level: ${context.education}. Wording: ${context.wording}. ${WORDING_RULES[context.wording]} Match the depth to the reader's education level.`;
  const base = grounded
    ? systemPrompt("lesson.write", { contentLanguage: context.language })
    : `Write all output in ${context.language}.\nWrite a short lesson on the topic from your general knowledge. Markdown only. Do not cite sources.`;
  return `${base}\n${style}`;
}

export function openLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
): { markdown: string; passageIds: string[]; itemId: string } {
  requireTopic(db, planId, topicId);
  const passages = passagesFor(db, topicId);
  const passageIds = passages.map((row) => row.id);
  const key = cacheKey({
    kind: "lesson",
    scopeId: topicId,
    passageIds,
    promptVersion: BOOK_VERSION,
  });
  const cached = loadLesson(db, { planId, kind: "lesson", key });
  if (cached)
    return {
      markdown: cached.markdown,
      passageIds: cached.passageIds,
      itemId: cached.itemId,
    };
  const markdown = bookMarkdown(passages);
  const itemId = saveLesson(db, {
    planId,
    topicId,
    kind: "lesson",
    key,
    markdown,
    passageIds,
  });
  return { markdown, passageIds, itemId };
}

/** Export the same current model lesson without generating or writing a cache row. */
export function readLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
  wording?: Wording,
) {
  const context = modelContext(db, planId, topicId, wording);
  const cached = loadLesson(db, { planId, kind: "lesson", key: context.key });
  return cached?.provider
    ? cached
    : { markdown: bookMarkdown(context.all), passageIds: context.all.map((row) => row.id) };
}

export type LessonResult = {
  markdown: string;
  passageIds: string[];
  itemId?: string;
  wording?: Wording;
  /** Model general knowledge, not the student's sources. */
  general?: boolean;
  fallback?: boolean;
};

export async function writeLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
  run?: Parameters<typeof generate>[0]["run"],
  options?: Pick<Parameters<typeof generate>[0], "signal" | "onDelta"> & {
    onPassages?: (passageIds: string[]) => void;
    wording?: Wording;
    /** Ignore the cached lesson for this variant; the old one stays if the new one fails. */
    regenerate?: boolean;
  },
): Promise<LessonResult> {
  const context = modelContext(db, planId, topicId, options?.wording);
  options?.signal?.throwIfAborted();
  const { used, passageIds, wording } = context;
  const grounded = used.length > 0;
  options?.onPassages?.(passageIds);
  // Only rows with provenance are model lessons; older fallback rows under this key are ignored and overwritten.
  const cached = loadLesson(db, { planId, kind: "lesson", key: context.key });
  if (cached?.provider && !options?.regenerate)
    return {
      markdown: cached.markdown,
      passageIds: cached.passageIds,
      itemId: cached.itemId,
      wording,
      ...(cached.grounding === "general" ? { general: true } : {}),
    };
  const bookFallback = () => ({
    ...openLesson(db, planId, topicId),
    wording,
    fallback: true,
  });
  if (!run && process.env["PYXIS_LESSON_MODEL"] !== "1") {
    return { ...openLesson(db, planId, topicId), wording };
  }
  // A failed or ungrounded generation returns the book text without caching it under the model key, so the next open retries.
  // A failed regeneration throws instead, so the student keeps the lesson already on screen.
  const failed = (error?: unknown): LessonResult => {
    if (options?.regenerate && cached?.provider)
      throw error instanceof Error ? error : new Error("lesson-invalid");
    return bookFallback();
  };
  const topic = db
    .prepare("SELECT title FROM topics WHERE id = ?")
    .get(topicId) as { title: string };
  let result;
  try {
    result = await generate({
      signal: options?.signal,
      onDelta: options?.onDelta,
      prompt: grounded
        ? `Topic: ${topic.title}\n\n${used
            .map((row, index) => `[P${index + 1}] ${row.text}`)
            .join("\n\n")}`
        : `Topic: ${topic.title}`,
      system: lessonSystem(context, grounded),
      selection: selectionFor(db, "lesson"),
      run,
    });
  } catch (error) {
    if (
      error instanceof IpcError ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          ("code" in error && error.code === "aborted")))
    )
      throw error;
    return failed(error);
  }
  const markdown = result.text.trim();
  options?.signal?.throwIfAborted();
  const valid = grounded
    ? citationsValid(markdown, passageIds.length)
    : !/\[P\d+\]/.test(markdown);
  if (!markdown || !valid) return failed();
  const itemId = saveLesson(db, {
    planId,
    topicId,
    kind: "lesson",
    key: context.key,
    markdown,
    passageIds,
    engine: { provider: result.provider, model: result.model },
    prompt: { template: "lesson.write", version: MODEL_VERSION },
    grounding: grounded ? "sources" : "general",
  });
  return {
    markdown,
    passageIds,
    itemId,
    wording,
    ...(grounded ? {} : { general: true }),
  };
}

/** Every [Pn] must index an ordered passage (1..count) and at least one must be present. */
export function citationsValid(markdown: string, count: number): boolean {
  const indices = [...markdown.matchAll(/\[P(\d+)\]/g)].map((m) =>
    Number(m[1]),
  );
  return indices.length > 0 && indices.every((n) => n >= 1 && n <= count);
}
