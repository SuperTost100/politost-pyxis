import type Database from "better-sqlite3";
import initSql from "./migrations/0001_init.sql?raw";

const steps = [
  { version: 1, sql: initSql },
  {
    version: 2,
    sql: `ALTER TABLE chats ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]'`,
  },
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true });
  const version = typeof current === "number" ? current : 0;
  const pending = steps.filter((step) => step.version > version);
  if (pending.length === 0) return;
  const apply = db.transaction(() => {
    for (const step of pending) {
      db.exec(step.sql);
      db.pragma(`user_version = ${step.version}`);
    }
  });
  apply();
}
