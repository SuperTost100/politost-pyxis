import type Database from "better-sqlite3";
import { dueCards } from "./cards";
import { topicExercises } from "./exercises";
import { flaggedIds } from "./flags";
import { mixQuestions } from "./mix";
import { saveQuiz, startAttempt } from "./attempt";

/** Due cards, up to five questions from weak topics, and three unseen book items. */
export function startReview(db: Database.Database, planId: string, now = Date.now()) {
  const cards = dueCards(db, planId, now).slice(0, 20).map((card) => ({
    id: card.id,
    front: card.front,
    topicId: card.topicId,
  }));
  const weak = db
    .prepare(
      `SELECT topic_id, payload_json FROM (
         SELECT topic_id, payload_json, created_at, rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY topic_id ORDER BY created_at DESC, rowid DESC
                ) AS n
         FROM learning_events
         WHERE plan_id = ? AND kind = 'answer_given' AND topic_id IS NOT NULL
       )
       WHERE n = 1
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(planId) as Array<{ topic_id: string; payload_json: string }>;
  const blocked = flaggedIds(db, "exercise");
  const gapRows: Array<{ id: string; prompt: string; answer: string | null }> = [];
  const seenTopics = new Set<string>();
  for (const row of weak) {
    if (seenTopics.has(row.topic_id)) continue;
    seenTopics.add(row.topic_id);
    let score: number | undefined;
    try {
      score = (JSON.parse(row.payload_json) as { score?: number }).score;
    } catch {
      score = undefined;
    }
    if (score === 1) continue;
    if (gapRows.length >= 5) continue;
    const exercise = topicExercises(db, row.topic_id).find(
      (item) => item.answer?.trim() && !blocked.has(item.id),
    );
    if (exercise) gapRows.push(exercise);
  }
  const frontier = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position LIMIT 1`)
    .get(planId) as { id: string } | undefined;
  const frontierLatest = frontier
    ? (db
        .prepare(
          `SELECT payload_json FROM learning_events
           WHERE plan_id = ? AND topic_id = ? AND kind = 'answer_given'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(planId, frontier.id) as { payload_json: string } | undefined)
    : undefined;
  let frontierPerfect = false;
  if (frontierLatest) {
    try {
      frontierPerfect = (JSON.parse(frontierLatest.payload_json) as { score?: number }).score === 1;
    } catch {
      frontierPerfect = false;
    }
  }
  const used = new Set<string>();
  const past = db
    .prepare(`SELECT body_json FROM items WHERE plan_id = ? AND kind IN ('quiz', 'review')`)
    .all(planId) as Array<{ body_json: string }>;
  for (const row of past) {
    try {
      const stored = JSON.parse(row.body_json) as {
        questions?: Array<{ sourceId?: string; sourceIds?: string[] }>;
      };
      for (const question of stored.questions ?? []) {
        for (const id of question.sourceIds ?? []) used.add(id);
        if (question.sourceId) used.add(question.sourceId);
      }
    } catch {
      continue;
    }
  }
  const unseen =
    frontier && !frontierPerfect
    ? topicExercises(db, frontier.id)
        .filter((item) => item.answer?.trim() && !blocked.has(item.id) && !used.has(item.id))
        .filter((item) => !gapRows.some((row) => row.id === item.id))
        .slice(0, 3)
    : [];
  const questions = mixQuestions(
    [...gapRows, ...unseen].map((row) => ({
      id: row.id,
      prompt: row.prompt,
      answer: row.answer ?? "",
    })),
    8,
  );
  if (questions.length === 0) return { cards, attemptId: "", questions: [] };
  const itemId = saveQuiz(db, planId, questions, now);
  db.prepare(`UPDATE items SET kind = 'review' WHERE id = ?`).run(itemId);
  const started = startAttempt(db, planId, itemId, now + 1);
  return { cards, attemptId: started.attemptId, questions: started.questions };
}
