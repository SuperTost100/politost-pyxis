import type Database from "better-sqlite3";
import { appendEvent } from "../events";
import { topicExercises } from "./exercises";
import { SELF_RATING_WINDOW_MS } from "./mastery";

export type SelfRating = "got" | "missed";

const SCORES: Record<SelfRating, number> = { got: 1, missed: 0 };

/**
 * The rating each exercise of a topic has now: the newest one, if it is less than a window old. An older rating still
 * counts as evidence (decayed), but a new visit starts unrated so the student rates it again.
 */
export function currentSelfRatings(
  db: Database.Database,
  topicId: string,
  now = Date.now(),
): Map<string, SelfRating> {
  const rows = db
    .prepare(
      `SELECT payload_json, created_at FROM learning_events
       WHERE topic_id = ? AND kind = 'answer_given' AND json_extract(payload_json, '$.evidenceKind') = 'self'
       ORDER BY created_at, rowid`,
    )
    .all(topicId) as Array<{ payload_json: string; created_at: number }>;
  const ratings = new Map<string, SelfRating>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      exerciseId?: string;
      rating?: SelfRating;
    };
    if (!payload.exerciseId || !(payload.rating! in SCORES)) continue;
    if (now - row.created_at < SELF_RATING_WINDOW_MS)
      ratings.set(payload.exerciseId, payload.rating!);
    else ratings.delete(payload.exerciseId);
  }
  return ratings;
}

/**
 * Records "Got it" or "Missed it" for one practice exercise as light mastery evidence (weight 0.5). Choosing the same
 * rating again writes nothing. Choosing the other one writes a new event; mastery counts only the newest rating of an
 * exercise within the window (see `currentRatings`). The event names the exercise in `questionScores`, so flagging the
 * exercise removes the rating like any other evidence from it.
 */
export function rateExercise(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    exerciseId: string;
    rating: SelfRating;
  },
  now = Date.now(),
): { rating: SelfRating } {
  const topic = db
    .prepare(
      "SELECT 1 FROM topics WHERE id = ? AND plan_id = ? AND archived_at IS NULL",
    )
    .get(input.topicId, input.planId);
  if (!topic) throw new Error("topic-missing");
  if (
    !topicExercises(db, input.topicId).some(
      (exercise) => exercise.id === input.exerciseId,
    )
  )
    throw new Error("exercise-missing");
  return db.transaction(() => {
    if (
      currentSelfRatings(db, input.topicId, now).get(input.exerciseId) !==
      input.rating
    )
      appendEvent(db, {
        kind: "answer_given",
        planId: input.planId,
        topicId: input.topicId,
        payload: {
          exerciseId: input.exerciseId,
          rating: input.rating,
          score: SCORES[input.rating],
          evidenceKind: "self",
          questionScores: [
            { id: input.exerciseId, score: SCORES[input.rating] },
          ],
        },
        at: now,
      });
    return { rating: input.rating };
  })();
}
