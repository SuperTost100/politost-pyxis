import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { QUIZ_MAX_QUESTIONS, saveQuiz, startAttempt } from "./attempt";
import { topicExercises } from "./exercises";
import { flaggedIds } from "./flags";
import { mixQuestions } from "./mix";
import { requireTopic } from "./openLesson";
import { openGrade } from "./topicQuiz";

// Study fixtures for tests: quizzes and cards written straight to the database, without a model.

/** A quiz from the topic's book exercises, mixed into closed questions where they allow it. */
export function startTopicQuiz(
  db: Database.Database,
  planId: string,
  topicId: string,
) {
  requireTopic(db, planId, topicId);
  const blocked = flaggedIds(db, "exercise");
  const exercises = topicExercises(db, topicId).filter(
    (row) => row.answer && row.answer.trim() && !blocked.has(row.id),
  );
  if (exercises.length === 0) throw new Error("quiz-empty");
  const mixed = mixQuestions(
    exercises.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      answer: row.answer ?? "",
      topicId,
      kind: row.kind,
    })),
    QUIZ_MAX_QUESTIONS,
  );
  const itemId = saveQuiz(
    db,
    planId,
    mixed.length > 0
      ? mixed.map((row) =>
          row.grade.kind === "completion"
            ? { ...row, grade: openGrade(row.grade.accepted[0]?.[0] ?? "") }
            : row,
        )
      : exercises.slice(0, QUIZ_MAX_QUESTIONS).map((row) => ({
          id: row.id,
          stem: row.prompt,
          explanation: row.answer ?? "",
          grade: openGrade(row.answer ?? ""),
        })),
  );
  db.prepare(`UPDATE items SET topic_id = ? WHERE id = ?`).run(topicId, itemId);
  return startAttempt(db, planId, itemId);
}

/** Cards for one topic. A front already on the topic is skipped; its missing passage is filled if the answer matches. */
export function seedCards(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    pairs: Array<{ front: string; back: string; passageId?: string | null }>;
  },
): string[] {
  const exists = db.prepare(
    `SELECT id, passage_id, back FROM cards
     WHERE plan_id = ? AND topic_id = ? AND (seed_key = ? OR (seed_key IS NULL AND TRIM(front) = ?))
     LIMIT 1`,
  );
  const link = db.prepare(
    `UPDATE cards SET passage_id = ? WHERE id = ? AND passage_id IS NULL`,
  );
  const insert = db.prepare(
    `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, passage_id, seed_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'sources', ?, ?, ?)`,
  );
  const ids: string[] = [];
  for (const pair of input.pairs) {
    const front = pair.front.trim();
    const back = pair.back.trim();
    const prior = exists.get(input.planId, input.topicId, front, front) as
      { id: string; passage_id: string | null; back: string } | undefined;
    if (prior) {
      if (
        prior.passage_id == null &&
        pair.passageId &&
        prior.back.trim() === back
      ) {
        link.run(pair.passageId, prior.id);
      }
      continue;
    }
    const now = Date.now();
    const id = uuidv7(now);
    insert.run(
      id,
      input.planId,
      input.topicId,
      front,
      back,
      pair.passageId ?? null,
      front,
      now,
    );
    ids.push(id);
  }
  return ids;
}
