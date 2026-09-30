import type Database from "better-sqlite3";
import { cacheKey, loadLesson, saveLesson } from "./lesson";

const PROMPT_VERSION = "book-1";

export function openLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
): { markdown: string; passageIds: string[] } {
  const passages = db
    .prepare(
      `SELECT p.id, p.text, p.section_path
       FROM topic_passages tp
       JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at, p.id`,
    )
    .all(topicId) as Array<{ id: string; text: string; section_path: string | null }>;
  const passageIds = passages.map((row) => row.id);
  const key = cacheKey({
    kind: "lesson",
    scopeId: topicId,
    passageIds,
    promptVersion: PROMPT_VERSION,
  });
  const cached = loadLesson(db, { planId, kind: "lesson", key });
  if (cached) return cached;
  const markdown = passages
    .map((row) => {
      const heading = row.section_path ? `## ${row.section_path}\n\n` : "";
      return `${heading}${row.text}`;
    })
    .join("\n\n");
  saveLesson(db, {
    planId,
    topicId,
    kind: "lesson",
    key,
    markdown,
    passageIds,
  });
  return { markdown, passageIds };
}
