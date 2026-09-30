import type Database from "better-sqlite3";
import { topicExercises } from "./exercises";

export function studyHandlers(db: Database.Database) {
  return {
    exercises(input: { topicId: string }) {
      return topicExercises(db, input.topicId);
    },
  };
}
