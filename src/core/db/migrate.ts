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
  // `messages.error` is the message key of the engine failure that cut a reply short, and `messages.passages_json` the
  // passages a stopped reply was written with, for Continue. `engine_usage` is one row per model
  // call with its tokens and the chat message or job it was for. The ids are plain text, so a deleted chat's or a
  // replaced reply's tokens still count in the week they were used.
  {
    version: 21,
    sql: `ALTER TABLE messages ADD COLUMN error TEXT;
ALTER TABLE messages ADD COLUMN passages_json TEXT CHECK (passages_json IS NULL OR json_valid(passages_json));
CREATE TABLE engine_usage (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  kind TEXT,
  chat_id TEXT,
  message_id TEXT,
  job_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX engine_usage_at ON engine_usage(at);
CREATE INDEX engine_usage_chat ON engine_usage(chat_id);
CREATE INDEX engine_usage_job ON engine_usage(job_id);`,
  },
  // A plan holds several exam sessions (a written and an oral part). plans.exam_at stays as the derived next exam date,
  // so countdowns, scheduling and the path keep reading one column. A plan's existing exam_at becomes its first session,
  // with the plan's id as the session id so the calendar event keeps its UID. A date after year 9999, which an older version accepted, is cut to the latest a session can hold. archived_at sets a finished exam aside.
  {
    version: 22,
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
  // Which engine answered when the one Pyxis chose refused the call, so the jobs list can say so on the finished job.
  {
    version: 23,
    sql: `ALTER TABLE jobs ADD COLUMN fallback_json TEXT CHECK (fallback_json IS NULL OR json_valid(fallback_json));`,
  },
  // Linked folders, read in place. A folder is one of the student's own folders: in `root` mode each subfolder is a
  // subject, in `subject` mode the folder is one. `linked_subfolders` maps a first-level subfolder ('' for the folder
  // itself) to its subject, or marks it skipped. `linked_files` is one file Pyxis read from there, with the size, time
  // and SHA-256 (`content_hash`, which names no stored blob) it had then, and the source that holds its text. Its
  // source_id turns NULL when the source is deleted, so the file is not read again. Only new tables: nothing that
  // existed before changes.
  {
    version: 24,
    sql: `CREATE TABLE linked_folders (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('root', 'subject')),
  detection TEXT CHECK (detection IS NULL OR detection IN ('ai', 'names')),
  cut_json TEXT CHECK (cut_json IS NULL OR json_valid(cut_json)),
  confirmed_at INTEGER,
  synced_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE linked_subfolders (
  folder_id TEXT NOT NULL REFERENCES linked_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  suggested TEXT,
  kinds_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(kinds_json)),
  skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
  PRIMARY KEY (folder_id, name)
);
CREATE INDEX linked_subfolders_subject ON linked_subfolders(subject_id);
CREATE TABLE linked_files (
  folder_id TEXT NOT NULL REFERENCES linked_folders(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  subfolder TEXT NOT NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT,
  missing_at INTEGER,
  PRIMARY KEY (folder_id, rel_path)
);
CREATE UNIQUE INDEX linked_files_source ON linked_files(source_id) WHERE source_id IS NOT NULL;`,
  },
  // Linked folders read in full. A file a look finds is recorded first and read later, a window at a time, so a folder
  // of tens of thousands of files never fills the job queue: `pending` is 1 for a file waiting for its first reading
  // (no source yet) and 2 for a changed file waiting to be read again. `sorted_at` is when the AI tool was asked which
  // subject a file lying loose at the top of a study folder belongs to. Rows that existed keep pending 0.
  {
    version: 25,
    sql: `ALTER TABLE linked_files ADD COLUMN pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1, 2));
ALTER TABLE linked_files ADD COLUMN sorted_at INTEGER;
CREATE INDEX linked_files_pending ON linked_files(folder_id) WHERE pending > 0;
CREATE INDEX linked_files_gone ON linked_files(size)
  WHERE missing_at IS NOT NULL AND source_id IS NOT NULL AND content_hash IS NOT NULL;`,
  },
  // A map belongs to a subject, and only optionally to an exam topic. `maps.plan_id` becomes nullable, which SQLite can
  // only do by rebuilding the table; nothing references `maps`, so the rows move as they are. Each row takes its
  // exam's subject (NULL when the exam has none). A row of a whole subject has no plan and no topic, and a subject
  // has at most one. The two triggers keep a topic map's subject equal to its exam's, whichever code writes either.
  {
    version: 26,
    sql: `CREATE TABLE maps_next (
  id TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL
);
INSERT INTO maps_next (id, subject_id, plan_id, topic_id, graph_json, engine_provider, model_id, model_source,
    prompt_template, prompt_version, grounding, created_at)
  SELECT m.id, p.subject_id, m.plan_id, m.topic_id, m.graph_json, m.engine_provider, m.model_id, m.model_source,
    m.prompt_template, m.prompt_version, m.grounding, m.created_at
  FROM maps m LEFT JOIN plans p ON p.id = m.plan_id;
DROP TABLE maps;
ALTER TABLE maps_next RENAME TO maps;
CREATE INDEX maps_plan ON maps(plan_id);
CREATE INDEX maps_topic ON maps(topic_id);
CREATE INDEX maps_subject ON maps(subject_id);
CREATE UNIQUE INDEX maps_whole_subject ON maps(subject_id) WHERE plan_id IS NULL AND topic_id IS NULL;
CREATE TRIGGER maps_take_plan_subject AFTER INSERT ON maps WHEN new.plan_id IS NOT NULL BEGIN
  UPDATE maps SET subject_id = (SELECT subject_id FROM plans WHERE id = new.plan_id) WHERE id = new.id;
END;
CREATE TRIGGER plans_subject_to_maps AFTER UPDATE OF subject_id ON plans BEGIN
  UPDATE maps SET subject_id = new.subject_id WHERE plan_id = new.id;
END;`,
  },
  // Importing a file looks its hash up among the files a linked folder reads in place. A scan does it for up to 2,000
  // files in a row, so the lookup has its own index, narrowed to the rows that lookup reads.
  {
    version: 27,
    sql: `CREATE INDEX linked_files_hash ON linked_files(content_hash) WHERE content_hash IS NOT NULL AND missing_at IS NULL;`,
  },
  // A flashcard belongs to a subject, and only optionally to an exam. `cards.plan_id` becomes nullable, which needs a
  // rebuilt table. `card_reviews` references `cards`, so this step runs with foreign keys off (see `migrate`): with
  // them on, dropping the old table would delete every review through the cascade. Each row keeps its id, its rowid
  // (the tie-break of the review order) and every column; `subject_id` is its exam's subject, NULL when the exam has
  // none. A card with a topic has an exam. The triggers keep an exam's cards on the exam's subject, as for maps.
  {
    version: 28,
    foreignKeysOff: { check: ["cards", "card_reviews"] },
    sql: `CREATE TABLE cards_next (
  id TEXT PRIMARY KEY,
  plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
  topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  engine_provider TEXT,
  model_id TEXT,
  model_source TEXT CHECK (model_source IS NULL OR model_source IN ('reported', 'selected')),
  prompt_template TEXT,
  prompt_version TEXT,
  grounding TEXT CHECK (grounding IS NULL OR grounding IN ('sources', 'mixed', 'general')),
  created_at INTEGER NOT NULL,
  passage_id TEXT REFERENCES passages(id) ON DELETE SET NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  seed_key TEXT,
  removed INTEGER NOT NULL DEFAULT 0,
  search_text TEXT,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  CHECK (topic_id IS NULL OR plan_id IS NOT NULL)
);
INSERT INTO cards_next (rowid, id, plan_id, topic_id, front, back, engine_provider, model_id, model_source,
    prompt_template, prompt_version, grounding, created_at, passage_id, suspended, seed_key, removed, search_text,
    subject_id)
  SELECT c.rowid, c.id, c.plan_id, c.topic_id, c.front, c.back, c.engine_provider, c.model_id, c.model_source,
    c.prompt_template, c.prompt_version, c.grounding, c.created_at, c.passage_id, c.suspended, c.seed_key, c.removed,
    c.search_text, p.subject_id
  FROM cards c LEFT JOIN plans p ON p.id = c.plan_id;
DROP TABLE cards;
ALTER TABLE cards_next RENAME TO cards;
CREATE INDEX cards_plan ON cards(plan_id, topic_id);
CREATE INDEX cards_topic ON cards(topic_id);
CREATE INDEX cards_passage ON cards(passage_id);
CREATE INDEX cards_subject ON cards(subject_id, plan_id);
CREATE INDEX cards_search_pending ON cards(id) WHERE search_text IS NULL;
CREATE TRIGGER cards_search_stale AFTER UPDATE OF front, back ON cards BEGIN
  UPDATE cards SET search_text = NULL WHERE id = new.id;
END;
CREATE TRIGGER cards_take_plan_subject AFTER INSERT ON cards WHEN new.plan_id IS NOT NULL BEGIN
  UPDATE cards SET subject_id = (SELECT subject_id FROM plans WHERE id = new.plan_id) WHERE id = new.id;
END;
CREATE TRIGGER cards_follow_plan AFTER UPDATE OF plan_id ON cards WHEN new.plan_id IS NOT NULL BEGIN
  UPDATE cards SET subject_id = (SELECT subject_id FROM plans WHERE id = new.plan_id) WHERE id = new.id;
END;
CREATE TRIGGER plans_subject_to_cards AFTER UPDATE OF subject_id ON plans BEGIN
  UPDATE cards SET subject_id = new.subject_id WHERE plan_id = new.id;
END;`,
  },
] satisfies Array<{ version: number; sql: string; foreignKeysOff?: { check: string[] } }>;

/** The newest schema version this build knows. */
export const SCHEMA_VERSION = steps.at(-1)!.version;

/** One broken reference as `foreign_key_check` reports it, named by the column that holds it. */
type Violation = { table: string; rowid: number | null; parent: string; column: string };

/**
 * The broken references of these tables. A reference is told apart by its table, row, parent table and column rather
 * than by the check's constraint index, which shifts when a rebuilt table gains a foreign key.
 */
function violationsOf(db: Database.Database, tables: string[]): Violation[] {
  return tables.flatMap((table) => {
    const columns = new Map(
      (db.pragma(`foreign_key_list(${table})`) as Array<{ id: number; from: string }>).map((key) => [key.id, key.from]),
    );
    return (
      db.pragma(`foreign_key_check(${table})`) as Array<{
        table: string;
        rowid: number | null;
        parent: string;
        fkid: number;
      }>
    ).map((row) => ({
      table: row.table,
      rowid: row.rowid,
      parent: row.parent,
      column: columns.get(row.fkid) ?? String(row.fkid),
    }));
  });
}

const violationKey = (v: Violation) => `${v.table}\n${v.rowid}\n${v.parent}\n${v.column}`;

/**
 * Brings the database up to `target` (the newest version by default; tests pass an older one to build a workspace as
 * an earlier release left it). All pending steps run in one transaction.
 *
 * A step that rebuilds a table other tables reference follows SQLite's procedure for it: foreign keys are switched off
 * before the transaction, since the pragma does nothing inside one and a DROP TABLE with them on runs the ON DELETE
 * actions of the referencing rows. The step names the tables whose references are checked before and after it. A
 * reference the rebuild broke rolls the whole migration back before foreign keys are switched on again. One that was
 * already broken stays as it is, because this upgrade did not cause it and refusing to start would lock the owner out of
 * their data; it is noted once in the log, with counts and no row content.
 */
export function migrate(db: Database.Database, target = SCHEMA_VERSION): void {
  const current = db.pragma("user_version", { simple: true });
  const version = typeof current === "number" ? current : 0;
  // A newer Pyxis wrote this workspace. Running on a schema this build does not know could damage it.
  if (version > SCHEMA_VERSION) throw new Error("workspace-newer");
  const pending = steps.filter((step) => step.version > version && step.version <= target);
  if (pending.length === 0) return;
  const keysOff = pending.some((step) => "foreignKeysOff" in step);
  const keysWereOn = db.pragma("foreign_keys", { simple: true }) === 1;
  if (keysOff && keysWereOn) {
    if (db.inTransaction) throw new Error("migrate-in-transaction");
    db.pragma("foreign_keys = OFF");
    if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("migrate-foreign-keys");
  }
  const old: Violation[] = [];
  try {
    const apply = db.transaction(() => {
      for (const step of pending) {
        const tables = "foreignKeysOff" in step && step.foreignKeysOff ? step.foreignKeysOff.check : [];
        const before = violationsOf(db, tables);
        db.exec(step.sql);
        const known = new Set(before.map(violationKey));
        const added = violationsOf(db, tables).find((violation) => !known.has(violationKey(violation)));
        if (added) throw new Error(`migrate-broken-references:${added.table}`);
        old.push(...before);
        db.pragma(`user_version = ${step.version}`);
      }
    });
    apply();
  } finally {
    if (keysOff && keysWereOn) db.pragma("foreign_keys = ON");
  }
  if (old.length > 0) {
    const counts = new Map<string, number>();
    for (const violation of old) {
      const key = `${violation.table}.${violation.column} -> ${violation.parent}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.warn(
      `pyxis-core: the workspace already held ${old.length} broken reference(s) before this upgrade and they were left as they are (${[...counts].map(([key, count]) => `${key}: ${count}`).join(", ")})`,
    );
  }
}
