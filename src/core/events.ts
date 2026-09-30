import type Database from "better-sqlite3";
import { uuidv7 } from "../shared/ids";

export const eventKinds = [
  "answer_given",
  "card_rated",
  "lesson_opened",
  "lesson_completed",
  "simulation_submitted",
  "active_time",
  "gap_opened",
  "gap_closed",
] as const;

export type EventKind = (typeof eventKinds)[number];

export type LearningEventInput = {
  kind: EventKind;
  planId?: string | null;
  topicId?: string | null;
  itemId?: string | null;
  sessionId?: string | null;
  payload?: unknown;
  at?: number;
};

export function appendEvent(
  db: Database.Database,
  event: LearningEventInput,
): string {
  const id = uuidv7(event.at);
  db.prepare(
    `INSERT INTO learning_events
      (id, kind, plan_id, topic_id, item_id, session_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.kind,
    event.planId ?? null,
    event.topicId ?? null,
    event.itemId ?? null,
    event.sessionId ?? null,
    JSON.stringify(event.payload ?? {}),
    event.at ?? Date.now(),
  );
  return id;
}
