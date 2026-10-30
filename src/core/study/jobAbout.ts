import type Database from "better-sqlite3";
import type { JobAbout } from "../jobs/runner";

/** The exam and topic a piece of study work is about, for the jobs list. A plan or topic that is gone adds nothing. */
export function aboutPlan(
  db: Database.Database,
  planId: string | undefined,
  topicId?: string | null,
): JobAbout {
  const exam = planId
    ? (db.prepare("SELECT title FROM plans WHERE id = ?").pluck().get(planId) as string | undefined)
    : undefined;
  const topic = topicId
    ? (db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(topicId) as string | undefined)
    : undefined;
  return { ...(exam ? { exam } : {}), ...(topic ? { topic } : {}) };
}

/** What an attempt's grading is about: its exam, and its topic, or that it is a diagnostic test or a Review. */
export function aboutAttempt(db: Database.Database, attemptId: string | undefined): JobAbout {
  const row = attemptId
    ? (db
        .prepare(
          "SELECT a.plan_id, i.topic_id, i.kind FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?",
        )
        .get(attemptId) as { plan_id: string; topic_id: string | null; kind: string } | undefined)
    : undefined;
  if (!row) return {};
  return {
    ...aboutPlan(db, row.plan_id, row.topic_id),
    ...(row.kind === "diagnostic" || row.kind === "review" ? { activity: row.kind } : {}),
  };
}
