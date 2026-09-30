import type Database from "better-sqlite3";
import initSql from "./migrations/0001_init.sql?raw";

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true });
  const version = typeof current === "number" ? current : 0;
  if (version >= 1) return;
  const apply = db.transaction(() => {
    db.exec(initSql);
    db.pragma("user_version = 1");
  });
  apply();
}
