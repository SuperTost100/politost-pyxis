import type Database from "better-sqlite3";

export function topicExercises(db: Database.Database, topicId: string) {
  const chapters = db
    .prepare(
      `SELECT DISTINCT json_extract(p.locator_json, '$.chapter') AS chapter
       FROM topic_passages tp
       JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ? AND json_extract(p.locator_json, '$.chapter') IS NOT NULL`,
    )
    .all(topicId) as Array<{ chapter: number }>;
  if (chapters.length === 0) return [];
  const marks = chapters.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT e.id, e.prompt, e.answer,
        COALESCE(e.passage_id, (
          SELECT p.id FROM passages p
          JOIN topic_passages tp ON tp.passage_id = p.id
          WHERE tp.topic_id = t.id
            AND p.source_id = sb.source_id
            AND json_extract(p.locator_json, '$.chapter') = json_extract(e.locator_json, '$.chapter')
          ORDER BY p.created_at
          LIMIT 1
        )) AS passage_id
       FROM exercises e
       JOIN smartbooks sb ON sb.id = e.smartbook_id
       JOIN plan_sources ps ON ps.source_id = sb.source_id
       JOIN topics t ON t.plan_id = ps.plan_id
       WHERE t.id = ?
         AND sb.source_id IN (
           SELECT p.source_id FROM passages p
           JOIN topic_passages src ON src.passage_id = p.id
           WHERE src.topic_id = t.id
         )
         AND json_extract(e.locator_json, '$.chapter') IN (${marks})
       ORDER BY e.created_at`,
    )
    .all(topicId, ...chapters.map((row) => row.chapter)) as Array<{
    id: string;
    prompt: string;
    answer: string | null;
    passage_id: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    prompt: row.prompt,
    answer: row.answer,
    passageId: row.passage_id,
  }));
}
