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
  // A free PoliTost book remembers which catalog book and version it is, so a newer version can be offered in place.
  // Books imported before this are linked when the catalog is next read, by their package's SHA-256.
  {
    version: 16,
    sql: `ALTER TABLE sources ADD COLUMN catalog_id TEXT;
ALTER TABLE sources ADD COLUMN catalog_version TEXT;`,
  },
  // Indexes for the hot lookups (latest card review, events by topic or item) and for every foreign-key child column
  // that had none, so a delete or cascade finds its rows without scanning the child table.
  {
    version: 17,
    sql: `CREATE INDEX card_reviews_card ON card_reviews(card_id, reviewed_at);
CREATE INDEX learning_events_topic ON learning_events(topic_id, kind);
CREATE INDEX learning_events_item ON learning_events(item_id, kind);
CREATE INDEX passages_document ON passages(document_id);
CREATE INDEX attempt_answers_attempt ON attempt_answers(attempt_id);
CREATE INDEX cards_plan ON cards(plan_id, topic_id);
CREATE INDEX items_plan ON items(plan_id, kind);
CREATE INDEX topics_plan ON topics(plan_id, position);
CREATE INDEX jobs_kind ON jobs(kind);
CREATE INDEX sources_subject ON sources(subject_id);
CREATE INDEX exercises_smartbook ON exercises(smartbook_id);
CREATE INDEX exercises_passage ON exercises(passage_id);
CREATE INDEX plans_subject ON plans(subject_id);
CREATE INDEX plan_sources_source ON plan_sources(source_id);
CREATE INDEX topics_parent ON topics(parent_id);
CREATE INDEX topic_passages_passage ON topic_passages(passage_id);
CREATE INDEX path_nodes_plan ON path_nodes(plan_id);
CREATE INDEX path_nodes_topic ON path_nodes(topic_id);
CREATE INDEX items_topic ON items(topic_id);
CREATE INDEX item_passages_passage ON item_passages(passage_id);
CREATE INDEX cards_topic ON cards(topic_id);
CREATE INDEX cards_passage ON cards(passage_id);
CREATE INDEX attempts_plan ON attempts(plan_id);
CREATE INDEX attempts_item ON attempts(item_id);
CREATE INDEX gaps_plan ON gaps(plan_id);
CREATE INDEX gaps_topic ON gaps(topic_id);
CREATE INDEX gaps_merged_into ON gaps(merged_into);
CREATE INDEX gap_items_item ON gap_items(item_id);
CREATE INDEX maps_plan ON maps(plan_id);
CREATE INDEX maps_topic ON maps(topic_id);
CREATE INDEX message_passages_passage ON message_passages(passage_id);
CREATE INDEX attachments_message ON attachments(message_id);`,
  },
  // The card browser searches a folded copy of each card's text. Core fills it for rows where it is NULL: new cards,
  // cards whose front or back changed (the trigger clears it) and every card the first time after this migration.
  {
    version: 18,
    sql: `ALTER TABLE cards ADD COLUMN search_text TEXT;
CREATE INDEX cards_search_pending ON cards(id) WHERE search_text IS NULL;
CREATE TRIGGER cards_search_stale AFTER UPDATE OF front, back ON cards BEGIN
  UPDATE cards SET search_text = NULL WHERE id = new.id;
END;`,
  },
  // Images of the figures an answer drew in the Python sandbox, by figure key, as PNG data URLs.
  {
    version: 19,
    sql: `ALTER TABLE messages ADD COLUMN figures_json TEXT CHECK (figures_json IS NULL OR json_valid(figures_json));`,
  },
  // Past exams: a source can be attached to a plan as one of its past papers. `role` says which, and `paper_json` holds
  // what the model read from the paper (questions, types, points, duration). Everything that builds the plan from its
  // sources reads `role = 'material'` only, so a past paper never becomes a topic, a lesson or a citation.
  {
    version: 20,
    sql: `ALTER TABLE plan_sources ADD COLUMN role TEXT NOT NULL DEFAULT 'material' CHECK (role IN ('material', 'past_paper'));
ALTER TABLE plan_sources ADD COLUMN paper_json TEXT CHECK (paper_json IS NULL OR json_valid(paper_json));`,
  },
  // A plan holds several exam sessions (a written and an oral part). plans.exam_at stays as the derived next exam date,
  // so countdowns, scheduling and the path keep reading one column. A plan's existing exam_at becomes its first session,
  // with the plan's id as the session id so the calendar event keeps its UID. A date after year 9999, which an older version accepted, is cut to the latest a session can hold. archived_at sets a finished exam aside.
  {
    version: 21,
    sql: `CREATE TABLE plan_sessions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  date INTEGER NOT NULL,
  time TEXT CHECK (time IS NULL OR time GLOB '[0-2][0-9]:[0-5][0-9]'),
  place TEXT,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX plan_sessions_plan ON plan_sessions(plan_id, date);
INSERT INTO plan_sessions (id, plan_id, date, created_at)
  SELECT id, id, MIN(exam_at, 253402163999999), COALESCE(updated_at, created_at) FROM plans WHERE exam_at IS NOT NULL;
ALTER TABLE plans ADD COLUMN archived_at INTEGER;`,
  },
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true });
  const version = typeof current === "number" ? current : 0;
  // A newer Pyxis wrote this workspace. Running on a schema this build does not know could damage it.
  if (version > steps.at(-1)!.version) throw new Error("workspace-newer");
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
