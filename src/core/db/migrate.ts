import type Database from "better-sqlite3";
import initSql from "./migrations/0001_init.sql?raw";

const steps = [
  { version: 1, sql: initSql },
  {
    version: 2,
    sql: `ALTER TABLE chats ADD COLUMN scope_json TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    version: 3,
    sql: `ALTER TABLE cards ADD COLUMN passage_id TEXT REFERENCES passages(id) ON DELETE SET NULL`,
  },
  {
    version: 4,
    sql: `ALTER TABLE plans ADD COLUMN exam_at INTEGER;
ALTER TABLE plans ADD COLUMN target REAL NOT NULL DEFAULT 0.75;
ALTER TABLE plans ADD COLUMN style TEXT NOT NULL DEFAULT 'decide';`,
  },
  {
    version: 5,
    sql: `ALTER TABLE messages ADD COLUMN reaction TEXT`,
  },
  {
    version: 6,
    sql: `ALTER TABLE cards ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`,
  },
  {
    version: 7,
    sql: `ALTER TABLE cards ADD COLUMN seed_key TEXT;
ALTER TABLE cards ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
UPDATE cards SET seed_key = TRIM(front) WHERE seed_key IS NULL AND grounding = 'sources';`,
  },
  {
    version: 8,
    sql: `ALTER TABLE sources ADD COLUMN origin_url TEXT;
ALTER TABLE sources ADD COLUMN fetched_at INTEGER;
ALTER TABLE item_passages ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 9,
    sql: `ALTER TABLE messages ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN subject TEXT;`,
  },
  {
    version: 10,
    sql: `ALTER TABLE chats ADD COLUMN context_json TEXT;
ALTER TABLE sources ADD COLUMN library INTEGER NOT NULL DEFAULT 1;`,
  },
  {
    version: 11,
    sql: `ALTER TABLE subjects ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
UPDATE subjects SET position = (SELECT COUNT(*) FROM subjects s WHERE s.name < subjects.name OR (s.name = subjects.name AND s.id < subjects.id));`,
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
