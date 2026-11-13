import type Database from "better-sqlite3";
import { finalRecap, parseSmartText } from "../../shared/smart-text";
import { readSteps } from "../plans/steps";
import { partTextSql } from "./partText";
import { smartAnswers } from "./smartText";

// Lessons written before lessons came in parts, and the one rule that says whether such a lesson is finished. An
// unfinished one is rewritten in parts the next time the student opens it; a finished one stays as it is, and the
// student may rewrite it in parts from its menu. Nothing here writes: the old lesson's row, its answers, citations and
// figures stay whatever happens to the topic.

export type OldLesson = {
  /** The old lesson the student worked on: the one the lesson step names, else the one answered last, else the newest. */
  itemId: string;
  /** The topic's lesson step is recorded, or every question of an old lesson's closing recap is answered. */
  finished: boolean;
};

/**
 * A lesson of the topic written before parts: a model's (`engine_provider` set, any prompt version and level) or one
 * imported from a plan file, which keeps its author's engine. Book text saved while no engine worked has no engine and
 * is no old lesson, and neither is a part. Newest first.
 */
const OLD_LESSONS_SQL = `SELECT i.id, i.body_json AS body,
    (SELECT MAX(e.created_at) FROM learning_events e WHERE e.item_id = i.id AND e.kind = 'answer_given') AS answeredAt
  FROM items i
  WHERE i.plan_id = ? AND i.topic_id = ? AND i.kind = 'lesson' AND i.engine_provider IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM lesson_parts lp WHERE ${partTextSql("lp", "i")})
  ORDER BY i.created_at DESC, i.rowid DESC`;

/** Whether every question of the lesson's closing recap has an answer. A lesson without a recap is finished by "Fatto". */
function recapAnswered(db: Database.Database, itemId: string, body: string): boolean {
  const markdown = (JSON.parse(body) as { markdown?: string }).markdown ?? "";
  const recap = finalRecap(parseSmartText(markdown));
  if (!recap || recap.questions.length === 0) return false;
  const answers = smartAnswers(db, itemId);
  return recap.questions.every((question) => answers[question.id] !== undefined);
}

/**
 * The topic's lesson written before parts, or null when it has none. Finished means the topic's lesson step is
 * recorded (through the closing recap, "Fatto", or a plan file that carried it), or an old lesson's recap is answered
 * in full, which records the step except on a topic archived at the time. Anything less, from a lesson never answered
 * to one answered up to its last question, is unfinished.
 */
export function oldLesson(db: Database.Database, planId: string, topicId: string): OldLesson | null {
  const rows = db.prepare(OLD_LESSONS_SQL).all(planId, topicId) as Array<{
    id: string;
    body: string;
    answeredAt: number | null;
  }>;
  if (rows.length === 0) return null;
  const step = readSteps(db, planId).find((entry) => entry.activity === "lesson" && entry.topicId === topicId);
  const named = step?.itemId ? rows.find((row) => row.id === step.itemId) : undefined;
  const answered = rows
    .filter((row) => row.answeredAt !== null)
    .reduce<(typeof rows)[number] | undefined>((last, row) => (!last || row.answeredAt! > last.answeredAt! ? row : last), undefined);
  const chosen = named ?? answered ?? rows[0]!;
  return {
    itemId: chosen.id,
    finished: step !== undefined || rows.some((row) => recapAnswered(db, row.id, row.body)),
  };
}
