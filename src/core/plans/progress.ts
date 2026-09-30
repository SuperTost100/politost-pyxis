import type Database from "better-sqlite3";
import { masteryFor, type MasteryEvent } from "../study/mastery";

export function planMastery(db: Database.Database, planId: string, now = Date.now()) {
  const topics = db
    .prepare(`SELECT id, title FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string; title: string }>;
  const rows = db
    .prepare(
      `SELECT topic_id, kind, created_at FROM learning_events
       WHERE plan_id = ? AND topic_id IS NOT NULL`,
    )
    .all(planId) as Array<{ topic_id: string; kind: string; created_at: number }>;
  const events: MasteryEvent[] = rows.map((row) => ({
    topicId: row.topic_id,
    kind: row.kind === "card_rated" ? "card" : row.kind === "answer_given" ? "quiz" : "lesson",
    score: row.kind === "lesson_completed" ? 1 : 0.5,
    at: row.created_at,
  }));
  const scores = masteryFor(events, now);
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    mastery: scores[topic.id] ?? 0,
  }));
}
