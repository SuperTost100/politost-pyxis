import type Database from "better-sqlite3";
import { saveQuiz, startAttempt, submitAttempt } from "./attempt";
import { topicExercises } from "./exercises";

export function startDiagnostic(db: Database.Database, planId: string) {
  const topics = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string }>;
  const questions = topics
    .flatMap((topic) =>
      topicExercises(db, topic.id)
        .filter((row) => row.answer && row.answer.trim())
        .map((row) => ({
          id: row.id,
          topicId: topic.id,
          stem: row.prompt,
          grade: { kind: "completion" as const, answers: [], accepted: [[row.answer ?? ""]] },
        })),
    )
    .slice(0, 20);
  if (questions.length === 0) throw new Error("quiz-empty");
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
  const exercises = topicExercises(db, topicId).filter((row) => row.answer && row.answer.trim());
  if (exercises.length === 0) throw new Error("quiz-empty");
  const itemId = saveQuiz(
    db,
    planId,
    exercises.slice(0, 20).map((row) => ({
      id: row.id,
      stem: row.prompt,
      grade: { kind: "completion" as const, answers: [], accepted: [[row.answer ?? ""]] },
    })),
  );
  db.prepare(`UPDATE items SET topic_id = ? WHERE id = ?`).run(topicId, itemId);
  return startAttempt(db, planId, itemId);
}

export { submitAttempt };
