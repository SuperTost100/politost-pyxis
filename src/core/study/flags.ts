import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";

export function flagTarget(
  db: Database.Database,
  targetKind: string,
  targetId: string,
  reason = "",
  now = Date.now(),
): void {
  const existing = db
    .prepare(`SELECT id FROM flags WHERE target_kind = ? AND target_id = ?`)
    .get(targetKind, targetId);
  if (existing) return;
  db.prepare(
    `INSERT INTO flags (id, target_kind, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(uuidv7(now), targetKind, targetId, reason, now);
}

export function flaggedIds(db: Database.Database, targetKind: string): Set<string> {
  const rows = db
    .prepare(`SELECT target_id FROM flags WHERE target_kind = ?`)
    .all(targetKind) as Array<{ target_id: string }>;
  return new Set(rows.map((row) => row.target_id));
}
