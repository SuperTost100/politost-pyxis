import type Database from "better-sqlite3";
import { saveQuiz, startAttempt, submitAttempt } from "./attempt";
import { topicExercises } from "./exercises";

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
