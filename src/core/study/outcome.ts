import type Database from "better-sqlite3";
import { planMastery } from "../plans/progress";

export type AttemptOutcome = {
  /** Topics whose mastery this attempt moved: just before it was handed in, and with its answers. */
  topics: Array<{ id: string; title: string; before: number; after: number }>;
  /** Gaps this attempt's wrong answers count for, with the model's reading of the mistake once it has one. */
  gaps: Array<{
    id: string;
    topicId: string;
    severity: "severe" | "minor" | null;
    misconception: string | null;
    open: boolean;
  }>;
  /** The latest call of this attempt (a check or the grading) that another engine answered because the chosen one refused. */
  fallback?: { from: string; to: string; reason: "limit" | "signed-out" | "model" };
};

/**
 * What an attempt changed in its exam's path. Its evidence carries the time the answers were handed in, so mastery
 * one millisecond earlier is the path without it and mastery at its last event is the path with it. Later study does
 * not blur the comparison. An attempt still open changes nothing yet, but can already have an engine fallback.
 */
export function attemptOutcome(
  db: Database.Database,
  attemptId: string,
): AttemptOutcome {
  const attempt = db
    .prepare("SELECT plan_id, submitted_at FROM attempts WHERE id = ?")
    .get(attemptId) as
    | { plan_id: string; submitted_at: number | null }
    | undefined;
  if (!attempt) throw new Error("attempt-missing");
  const fallbackRow = db
    .prepare(
      `SELECT fallback_json FROM jobs
       WHERE json_extract(params_json, '$.attemptId') = ? AND fallback_json IS NOT NULL
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    )
    .get(attemptId) as { fallback_json: string } | undefined;
  const fallback = fallbackRow
    ? (JSON.parse(fallbackRow.fallback_json) as AttemptOutcome["fallback"])
    : undefined;
  if (attempt.submitted_at == null)
    return { topics: [], gaps: [], ...(fallback ? { fallback } : {}) };
  const at = attempt.submitted_at;
  // A simulation writes one event per topic a millisecond apart, so the path with the attempt is read at its last one.
  const last = db
    .prepare(
      `SELECT max(created_at) AS at FROM learning_events
       WHERE plan_id = ? AND json_extract(payload_json, '$.attemptId') = ?`,
    )
    .get(attempt.plan_id, attemptId) as { at: number | null };
  const before = new Map(
    planMastery(db, attempt.plan_id, at - 1).map((topic) => [
      topic.id,
      topic.mastery,
    ]),
  );
  const topics = planMastery(db, attempt.plan_id, Math.max(at, last.at ?? at))
    .map((topic) => ({
      id: topic.id,
      title: topic.title,
      before: before.get(topic.id) ?? 0,
      after: topic.mastery,
    }))
    .filter((topic) => Math.abs(topic.after - topic.before) > 1e-9);
  const gaps = (
    db
      .prepare(
        `SELECT DISTINCT g.id, g.topic_id, g.severity, g.misconception, g.closed_at
         FROM gap_answers ga JOIN gaps g ON g.id = ga.gap_id
         WHERE ga.attempt_id = ? AND g.topic_id IS NOT NULL AND g.merged_into IS NULL
         ORDER BY g.opened_at`,
      )
      .all(attemptId) as Array<{
      id: string;
      topic_id: string;
      severity: "severe" | "minor" | null;
      misconception: string | null;
      closed_at: number | null;
    }>
  ).map((gap) => ({
    id: gap.id,
    topicId: gap.topic_id,
    severity: gap.severity,
    misconception: gap.misconception,
    open: gap.closed_at == null,
  }));
  return { topics, gaps, ...(fallback ? { fallback } : {}) };
}
