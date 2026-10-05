import type Database from "better-sqlite3";
import { educationLevels, readProfile, type EducationLevel } from "../profile/profile";

// ASK-09: a plan answers at its own education level. It is copied from the profile when the plan
// is made and never follows later profile edits. A settings row, not a column: only this
// lookup reads it (ponytail: move to plans.education_level if reports need to query it).
const key = (planId: string) => `plan-education:${planId}`;

export const educationKey = key;

function stored(db: Database.Database, planId: string): EducationLevel | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(key(planId)) as { value_json: string } | undefined;
  const level = row ? (JSON.parse(row.value_json) as { level?: unknown }).level : null;
  return educationLevels.find((item) => item === level) ?? null;
}

function put(db: Database.Database, planId: string, level: EducationLevel, now: number) {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key(planId), JSON.stringify({ level }), now);
}

/** Copies the profile's level onto the plan. Call when the plan is created. */
export function snapshotPlanEducation(
  db: Database.Database,
  planId: string,
  level?: EducationLevel,
  now = Date.now(),
): EducationLevel {
  const chosen = level ?? readProfile(db)?.educationLevel ?? "university";
  put(db, planId, chosen, now);
  return chosen;
}

/** The plan's level. A plan from before this setting gets the profile's current level, once, and keeps it. */
export function planEducation(
  db: Database.Database,
  planId: string,
  now = Date.now(),
): EducationLevel | null {
  if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId)) return null;
  return stored(db, planId) ?? snapshotPlanEducation(db, planId, undefined, now);
}

export function setPlanEducation(
  db: Database.Database,
  planId: string,
  level: EducationLevel,
  now = Date.now(),
): EducationLevel {
  if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId))
    throw new Error("plan-missing");
  put(db, planId, level, now);
  return level;
}
