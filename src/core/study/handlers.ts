import type Database from "better-sqlite3";
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
      return submitAttempt(db, input.attemptId, input.picks);
    },
    cards(input: { planId: string; topicId: string }) {
      ensureTopicCards(db, input.planId, input.topicId);
      return dueCards(db, input.planId, Date.now()).filter(
        (card) => card.topicId === input.topicId,
      );
    },
    rate(input: { cardId: string; rating: Rating }) {
      return rateCard(db, input.cardId, input.rating, Date.now());
    },
  };
}
