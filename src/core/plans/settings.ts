import type Database from "better-sqlite3";
import { z } from "zod";

export const planSettingsSchema = z.object({
  planId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  target: z.number().finite().min(0.5).max(1),
  examAt: z.number().int().min(0).max(8_640_000_000_000_000).nullable(),
});

export function savePlanSettings(
  db: Database.Database,
  input: z.input<typeof planSettingsSchema>,
  now = Date.now(),
) {
  const settings = planSettingsSchema.parse(input);
  const result = db
    .prepare(
      "UPDATE plans SET title=?,target=?,exam_at=?,updated_at=? WHERE id=? AND status!='building'",
    )
    .run(
      settings.title,
      settings.target,
      settings.examAt,
      now,
      settings.planId,
    );
  if (!result.changes) throw new Error("plan-missing-or-building");
  return { ok: true as const };
}
