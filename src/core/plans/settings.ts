import type Database from "better-sqlite3";
import { z } from "zod";
import { PLAN_TITLE_MAX } from "../../shared/plan-file";
import { examSessionsSchema } from "../../shared/exam-sessions";
import { saveSessions } from "./sessions";

export const planSettingsSchema = z.object({
  planId: z.string().min(1),
  title: z.string().trim().min(1).max(PLAN_TITLE_MAX),
  target: z.number().finite().min(0.5).max(1),
  /** The plan's exam sessions, replacing the old list. Empty is "No date yet". */
  sessions: examSessionsSchema,
});

export function savePlanSettings(
  db: Database.Database,
  input: z.input<typeof planSettingsSchema>,
  now = Date.now(),
) {
  const settings = planSettingsSchema.parse(input);
  return db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE plans SET title=?,target=?,updated_at=? WHERE id=? AND status!='building'",
      )
      .run(settings.title, settings.target, now, settings.planId);
    if (!result.changes) throw new Error("plan-missing-or-building");
    saveSessions(db, settings.planId, settings.sessions, now);
    return { ok: true as const };
  })();
}

/** Sets a finished exam aside, or brings it back. An archived plan drops out of review queues, counts and recommendations. */
export function setPlanArchived(
  db: Database.Database,
  planId: string,
  archived: boolean,
  now = Date.now(),
) {
  const result = db
    .prepare(
      "UPDATE plans SET archived_at=?,updated_at=? WHERE id=? AND status!='building'",
    )
    .run(archived ? now : null, now, planId);
  if (!result.changes) throw new Error("plan-missing-or-building");
  return { ok: true as const };
}

/**
 * What deleting a plan takes with it, for the confirmation that lists it: its topics, the lessons Pyxis wrote, the
 * quizzes and simulations the student handed in, and the flashcards still in use. An archived plan counts the same.
 */
export function planFootprint(db: Database.Database, planId: string) {
  const row = db
    .prepare(
      `SELECT
        (SELECT count(*) FROM topics WHERE plan_id = @plan AND archived_at IS NULL) AS topics,
        (SELECT count(*) FROM items WHERE plan_id = @plan AND kind = 'lesson') AS lessons,
        (SELECT count(*) FROM attempts a JOIN items i ON i.id = a.item_id
          WHERE a.plan_id = @plan AND a.submitted_at IS NOT NULL AND i.kind IN ('quiz', 'diagnostic')) AS quizzes,
        (SELECT count(*) FROM attempts a JOIN items i ON i.id = a.item_id
          WHERE a.plan_id = @plan AND a.submitted_at IS NOT NULL AND i.kind = 'simulation') AS simulations,
        (SELECT count(*) FROM cards WHERE plan_id = @plan AND removed = 0) AS cards
      FROM plans WHERE id = @plan`,
    )
    .get({ plan: planId }) as
    | { topics: number; lessons: number; quizzes: number; simulations: number; cards: number }
    | undefined;
  if (!row) throw new Error("plan-missing");
  return row;
}
