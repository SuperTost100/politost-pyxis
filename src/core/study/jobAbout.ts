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

/** What an attempt's grading is about: its exam, and its topic, or that it is a diagnostic test or a Review (with the topics it asked about). */
export function aboutAttempt(db: Database.Database, attemptId: string | undefined): JobAbout {
  const row = attemptId
    ? (db
        .prepare(
          "SELECT a.plan_id, i.topic_id, i.kind, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?",
        )
        .get(attemptId) as
        | { plan_id: string; topic_id: string | null; kind: string; body_json: string }
        | undefined)
    : undefined;
  if (!row) return {};
  // A Review has no topic of its own: its questions come from several, each naming its own.
  const topics =
    row.kind === "review"
      ? reviewTopics(db, row.plan_id, JSON.parse(row.body_json) as { questions?: Array<{ topicId?: string }> })
      : [];
  return {
    ...aboutPlan(db, row.plan_id, row.topic_id),
    ...(row.kind === "diagnostic" || row.kind === "review" ? { activity: row.kind } : {}),
    ...(topics.length ? { topics } : {}),
  };
}

/** The titles of the topics a Review's questions belong to, each once, in question order. */
function reviewTopics(db: Database.Database, planId: string, body: { questions?: Array<{ topicId?: string }> }): string[] {
  const ids = [...new Set((body.questions ?? []).flatMap((question) => (question.topicId ? [question.topicId] : [])))];
  const title = db.prepare("SELECT title FROM topics WHERE id = ? AND plan_id = ?").pluck();
  return ids.flatMap((id) => {
    const found = title.get(id, planId) as string | undefined;
    return found ? [found] : [];
  });
}
