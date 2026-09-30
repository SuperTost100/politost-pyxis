import type Database from "better-sqlite3";
import { seedCards } from "./cards";
import { topicExercises } from "./exercises";

export function ensureTopicCards(db: Database.Database, planId: string, topicId: string): void {
  const passages = db
    .prepare(
      `SELECT p.id, p.text, p.section_path
       FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at
       LIMIT 20`,
    )
    .all(topicId) as Array<{ id: string; text: string; section_path: string | null }>;
  const pairs: Array<{ front: string; back: string; passageId?: string | null }> = passages.map(
    (row, index) => ({
      front: row.section_path?.trim()
        ? `${row.section_path.trim()} · ${index + 1}`
        : row.text.replace(/\s+/g, " ").trim().slice(0, 48),
      back: row.text.slice(0, 600),
      passageId: row.id,
    }),
  );
  for (const exercise of topicExercises(db, topicId).slice(0, 20)) {
    if (!exercise.answer) continue;
    pairs.push({
      front: exercise.prompt.slice(0, 400),
      back: exercise.answer.slice(0, 600),
      passageId: exercise.passageId,
    });
  }
  seedCards(db, { planId, topicId, pairs });
}
