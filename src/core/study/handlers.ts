import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { dueCards, rateCard } from "./cards";
import { ensureTopicCards } from "./cardsFromBook";
import { topicExercises } from "./exercises";
import { openLesson } from "./openLesson";
import type { Rating } from "./schedule";
import { syncGaps } from "../plans/progress";
import { openSimulation, readSimulation, startSimulation } from "./simulation";
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
          `SELECT a.plan_id, i.topic_id, i.kind, i.body_json FROM attempts a
           JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
        )
        .get(input.attemptId) as
        | { plan_id: string; topic_id: string | null; kind: string; body_json: string }
        | undefined;
      if (row) {
        const now = Date.now();
        const record = (topicId: string | null, score: number, scores: number[], at: number) => {
          db.prepare(
            `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
             VALUES (?, 'answer_given', ?, ?, ?, ?)`,
          ).run(
            uuidv7(at),
            row.plan_id,
            topicId,
            JSON.stringify({ score, scores }),
            at,
          );
        };
        if (row.topic_id) {
          record(
            row.topic_id,
            scored.score,
            scored.results.map((result) => result.score),
            now,
          );
        } else if (row.kind === "simulation") {
          const stored = JSON.parse(row.body_json) as {
            questions?: Array<{ id: string; topicId?: string }>;
          };
          const byTopic = new Map<string, number[]>();
          for (const result of scored.results) {
            const topicId = stored.questions?.find((question) => question.id === result.id)?.topicId;
            if (!topicId) continue;
            const list = byTopic.get(topicId) ?? [];
            list.push(result.score);
            byTopic.set(topicId, list);
          }
          let at = now;
          for (const [topicId, scores] of byTopic) {
            const score = scores.reduce((sum, item) => sum + item, 0) / scores.length;
            record(topicId, score, scores, at);
            at += 1;
          }
        }
        syncGaps(db, row.plan_id, now);
      }
      return scored;
    },
    cards(input: { planId: string; topicId: string }) {
      ensureTopicCards(db, input.planId, input.topicId);
      return dueCards(db, input.planId, Date.now(), input.topicId);
    },
    simulationOpen(input: { planId: string }) {
      return openSimulation(db, input.planId);
    },
    simulationStart(input: { planId: string }) {
      return startSimulation(db, input.planId, 30);
    },
    simulationRead(input: { attemptId: string }) {
      return readSimulation(db, input.attemptId);
    },
    rate(input: { cardId: string; rating: Rating }) {
      return rateCard(db, input.cardId, input.rating, Date.now());
    },
    active(input: { planId: string; topicId: string | null; seconds: number }) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'active_time', ?, ?, ?, ?)`,
      ).run(
        uuidv7(now),
        input.planId,
        input.topicId,
        JSON.stringify({ seconds: input.seconds }),
        now,
      );
      return { ok: true as const };
    },
  };
}
