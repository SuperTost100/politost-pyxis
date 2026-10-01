import type Database from "better-sqlite3";
import { completeNode } from "../plans/create";
import { saveQuiz, startAttempt, submitAttempt } from "./attempt";
import { mixQuestions } from "./mix";
import { topicExercises } from "./exercises";
import { flaggedIds } from "./flags";
import { requireTopic } from "./openLesson";

export function acrossTopics<T>(buckets: T[][], limit: number): T[] {
  const picked: T[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      const row = bucket[round];
      if (!row) continue;
      picked.push(row);
      added = true;
      if (picked.length === limit) break;
    }
    if (!added) break;
  }
  return picked;
}

export function startDiagnostic(db: Database.Database, planId: string) {
  const topics = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string }>;
  const questions = acrossTopics(
    topics.map((topic) =>
      topicExercises(db, topic.id)
        .filter((row) => row.answer && row.answer.trim())
        .map((row) => ({
          id: row.id,
          topicId: topic.id,
          stem: row.prompt,
          grade: { kind: "completion" as const, answers: [], accepted: [[row.answer ?? ""]] },
        })),
    ),
    20,
  );
  if (questions.length === 0) {
    const node = db
      .prepare(`SELECT id FROM path_nodes WHERE plan_id = ? AND kind = 'diagnostic'`)
      .get(planId) as { id: string } | undefined;
    if (node) {
      try {
        completeNode(db, planId, node.id);
      } catch (err) {
        if (!(err instanceof Error) || err.message !== "node-locked") throw err;
      }
    }
    return { attemptId: "", questions: [] };
  }
  const itemId = saveQuiz(
    db,
    planId,
    questions.map((row) => ({ id: row.id, stem: row.stem, grade: row.grade })),
  );
  const stored = JSON.parse(
    (db.prepare(`SELECT body_json FROM items WHERE id = ?`).get(itemId) as { body_json: string })
      .body_json,
  ) as { questions: Array<{ id: string; topicId?: string }> };
  stored.questions.forEach((question, index) => {
    question.topicId = questions[index]?.topicId;
  });
  db.prepare(`UPDATE items SET kind = 'diagnostic', body_json = ? WHERE id = ?`).run(
    JSON.stringify(stored),
    itemId,
  );
  return startAttempt(db, planId, itemId);
}

export function startTopicQuiz(db: Database.Database, planId: string, topicId: string) {
  requireTopic(db, planId, topicId);
  const blocked = flaggedIds(db, "exercise");
  const exercises = topicExercises(db, topicId).filter(
    (row) => row.answer && row.answer.trim() && !blocked.has(row.id),
  );
  if (exercises.length === 0) throw new Error("quiz-empty");
  const mixed = mixQuestions(
    exercises.map((row) => ({ id: row.id, prompt: row.prompt, answer: row.answer ?? "" })),
  );
  const itemId = saveQuiz(db, planId, mixed.length > 0 ? mixed : exercises.slice(0, 20).map((row) => ({
    id: row.id,
    stem: row.prompt,
    explanation: row.answer ?? "",
    grade: { kind: "completion" as const, answers: [], accepted: [[row.answer ?? ""]] },
  })));
  db.prepare(`UPDATE items SET topic_id = ? WHERE id = ?`).run(topicId, itemId);
  return startAttempt(db, planId, itemId);
}

export { submitAttempt };
