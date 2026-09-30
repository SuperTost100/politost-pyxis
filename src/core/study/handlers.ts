import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { dueCards, rateCard } from "./cards";
import { ensureTopicCards } from "./cardsFromBook";
import { topicExercises } from "./exercises";
import { openLesson } from "./openLesson";
import type { Rating } from "./schedule";
import { startTopicQuiz, submitAttempt } from "./topicQuiz";

export function studyHandlers(db: Database.Database) {
  return {
    exercises(input: { topicId: string }) {
      return topicExercises(db, input.topicId);
    },
    lesson(input: { planId: string; topicId: string }) {
      return openLesson(db, input.planId, input.topicId);
    },
    quizStart(input: { planId: string; topicId: string }) {
      return startTopicQuiz(db, input.planId, input.topicId);
    },
    quizSubmit(input: { attemptId: string; picks: Record<string, string> }) {
      const scored = submitAttempt(db, input.attemptId, input.picks);
      const row = db
        .prepare(
          `SELECT a.plan_id, i.topic_id FROM attempts a
           JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
        )
        .get(input.attemptId) as { plan_id: string; topic_id: string | null } | undefined;
      if (row?.topic_id) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
           VALUES (?, 'answer_given', ?, ?, ?, ?)`,
        ).run(uuidv7(now), row.plan_id, row.topic_id, JSON.stringify({ score: scored.score }), now);
      }
      return scored;
    },
    cards(input: { planId: string; topicId: string }) {
      ensureTopicCards(db, input.planId, input.topicId);
      return dueCards(db, input.planId, Date.now(), input.topicId);
    },
    rate(input: { cardId: string; rating: Rating }) {
      return rateCard(db, input.cardId, input.rating, Date.now());
    },
  };
}
