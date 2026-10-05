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
  { version: 12, sql: `ALTER TABLE topics ADD COLUMN tree_json TEXT CHECK (tree_json IS NULL OR json_valid(tree_json));
ALTER TABLE jobs ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;` },
  // PLAN-13: a rebuild archives topics that match nothing instead of deleting them, so progress history stays attached.
  { version: 13, sql: `ALTER TABLE topics ADD COLUMN archived_at INTEGER;` },
  // PRO-02: one model analysis of a gap's grouped mistakes; both stay null until it lands.
  {
    version: 14,
    sql: `ALTER TABLE gaps ADD COLUMN misconception TEXT;
ALTER TABLE gaps ADD COLUMN severity TEXT CHECK (severity IS NULL OR severity IN ('severe', 'minor'));`,
  },
  // PRO-02 / PRO-08: a distinct misconception is its own gap. `origin` says how a gap opened, `comparison` is 'unchecked'
  // while it could not be compared with its siblings, `merged_into` names the gap that absorbed it, and `gap_answers`
  // links each wrong answer (attempt + question) to the gap it counts for, for ranking and closing.
  {
    version: 15,
    sql: `ALTER TABLE gaps ADD COLUMN origin TEXT NOT NULL DEFAULT 'answers' CHECK (origin IN ('answers', 'flag', 'misconception'));
ALTER TABLE gaps ADD COLUMN comparison TEXT CHECK (comparison IS NULL OR comparison = 'unchecked');
ALTER TABLE gaps ADD COLUMN merged_into TEXT REFERENCES gaps(id) ON DELETE SET NULL;
CREATE TABLE gap_answers (
  gap_id TEXT NOT NULL REFERENCES gaps(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  PRIMARY KEY (gap_id, attempt_id, question_id)
);
CREATE INDEX gap_answers_attempt ON gap_answers (attempt_id, question_id);`,
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
