import type Database from "better-sqlite3";
import { generate } from "../engine/generate";
import { selectionFor } from "../engine/selection";
import { cacheKey, loadLesson, saveLesson } from "./lesson";

const BOOK_VERSION = "book-1";
const MODEL_VERSION = "model-1";

function passagesFor(db: Database.Database, topicId: string) {
  return db
    .prepare(
      `SELECT p.id, p.text, p.section_path
       FROM topic_passages tp
       JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at, p.id`,
    )
    .all(topicId) as Array<{ id: string; text: string; section_path: string | null }>;
}

function bookMarkdown(
  passages: Array<{ text: string; section_path: string | null }>,
): string {
  return passages
    .map((row) => {
      const heading = row.section_path ? `## ${row.section_path}\n\n` : "";
      return `${heading}${row.text}`;
    })
    .join("\n\n");
}

export function requireTopic(db: Database.Database, planId: string, topicId: string) {
  const row = db
    .prepare(`SELECT id FROM topics WHERE id = ? AND plan_id = ?`)
    .get(topicId, planId) as { id: string } | undefined;
  if (!row) throw new Error("topic-missing");
}

export function openLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
): { markdown: string; passageIds: string[] } {
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
  if (cached) return cached;
  const markdown = bookMarkdown(passages);
  saveLesson(db, { planId, topicId, kind: "lesson", key, markdown, passageIds });
  return { markdown, passageIds };
}

export async function writeLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
  run?: Parameters<typeof generate>[0]["run"],
): Promise<{ markdown: string; passageIds: string[] }> {
  requireTopic(db, planId, topicId);
  const passages = passagesFor(db, topicId);
  const passageIds = passages.map((row) => row.id);
  const key = cacheKey({
    kind: "lesson",
    scopeId: topicId,
    passageIds,
    promptVersion: MODEL_VERSION,
  });
  const cached = loadLesson(db, { planId, kind: "lesson", key });
  if (cached) return cached;
  const book = bookMarkdown(passages);
  let markdown = book;
  if (run || process.env["PYXIS_LESSON_MODEL"] === "1") {
    try {
      const result = await generate({
        prompt: passages.map((row, index) => `[P${index + 1}] ${row.text}`).join("\n\n"),
        system:
          "Write a short lesson from these passages. Cite a passage as [P1]. Markdown only.",
        selection: selectionFor(db, "lesson"),
        run,
      });
      if (result.text.trim()) markdown = result.text.trim();
    } catch {
      // ponytail: a failed model call stores the book text. Upgrade path is a failed row so the next open retries.
      markdown = book;
    }
  } else {
    return openLesson(db, planId, topicId);
  }
  saveLesson(db, { planId, topicId, kind: "lesson", key, markdown, passageIds });
  return { markdown, passageIds };
}
