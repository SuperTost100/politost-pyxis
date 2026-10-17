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
