import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  nextExamDate,
  type ExamSession,
  type ExamSessionInput,
} from "../../shared/exam-sessions";

/** A plan's sessions in the order they happen: by day, then by start time, a session without a time first. */
export function readSessions(
  db: Database.Database,
  planId: string,
): ExamSession[] {
  return db
    .prepare(
      `SELECT id, date, time, place, label FROM plan_sessions WHERE plan_id = ?
       ORDER BY date, time IS NOT NULL, time, created_at, id`,
    )
    .all(planId) as ExamSession[];
}

/**
 * Points `plans.exam_at` at the next exam date again. Time passing moves it (the written part is over, the oral part is
 * next), so the lists and the plan page call this before they read `exam_at`. A plan with no sessions keeps whatever
 * `exam_at` holds, which is null once its sessions are gone.
 */
export function syncExamDates(
  db: Database.Database,
  now: number,
  planId?: string,
): void {
  const rows = db
    .prepare(
      `SELECT p.id, p.exam_at AS examAt FROM plans p
       WHERE (? IS NULL OR p.id = ?) AND EXISTS (SELECT 1 FROM plan_sessions s WHERE s.plan_id = p.id)`,
    )
    .all(planId ?? null, planId ?? null) as Array<{
    id: string;
    examAt: number | null;
  }>;
  const dates = db.prepare("SELECT date FROM plan_sessions WHERE plan_id = ?");
  const update = db.prepare("UPDATE plans SET exam_at = ? WHERE id = ?");
  for (const row of rows) {
    const next = nextExamDate(
      (dates.all(row.id) as Array<{ date: number }>).map((d) => d.date),
      now,
    );
    if (next !== row.examAt) update.run(next, row.id);
  }
}

/**
 * Replaces a plan's sessions with `sessions`. A session that names an ID of this plan keeps it (and its calendar UID);
 * one without an ID is new. An ID that belongs to another plan is treated as new.
 */
export function saveSessions(
  db: Database.Database,
  planId: string,
  sessions: ExamSessionInput[],
  now = Date.now(),
): void {
  const run = db.transaction(() => {
    const existing = new Set(
      (
        db
          .prepare("SELECT id FROM plan_sessions WHERE plan_id = ?")
          .all(planId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const keep = new Set<string>();
    const upsert = db.prepare(
      `INSERT INTO plan_sessions (id, plan_id, date, time, place, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET date = excluded.date, time = excluded.time,
         place = excluded.place, label = excluded.label`,
    );
    sessions.forEach((session, i) => {
      const id =
        session.id && existing.has(session.id) && !keep.has(session.id)
          ? session.id
          : uuidv7(now + i);
      keep.add(id);
      upsert.run(
        id,
        planId,
        session.date,
        session.time ?? null,
        session.place?.trim() || null,
        session.label?.trim() || null,
        now,
      );
    });
    for (const id of existing)
      if (!keep.has(id))
        db.prepare("DELETE FROM plan_sessions WHERE id = ?").run(id);
    if (sessions.length === 0)
      db.prepare("UPDATE plans SET exam_at = NULL WHERE id = ?").run(planId);
    else syncExamDates(db, now, planId);
  });
  run();
}

/** The sessions a request carries: its list, or the single `examAt` of the older shape, or none. */
export function sessionsFromInput(input: {
  sessions?: ExamSessionInput[] | undefined;
  examAt?: number | null | undefined;
}): ExamSessionInput[] {
  if (input.sessions) return input.sessions;
  return input.examAt == null ? [] : [{ date: input.examAt }];
}

export function hasSessions(db: Database.Database, planId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM plan_sessions WHERE plan_id = ?").get(planId),
  );
}
