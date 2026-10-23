import type Database from "better-sqlite3";

/** Stores `value` as JSON under `key` in the settings table, replacing what was there. */
export function putSetting(db: Database.Database, key: string, value: unknown, now = Date.now()): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}
