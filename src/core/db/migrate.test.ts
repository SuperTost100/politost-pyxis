import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { openDatabase } from "./connection";
import { migrate, SCHEMA_VERSION } from "./migrate";
import { uuidv7 } from "../../shared/ids";
import { tempDir } from "../test-temp";

const opened: Array<{ close: () => void }> = [];

function tempDb() {
  const dir = tempDir("pyxis-db-");
  const db = openDatabase(join(dir, "pyxis.db"));
  opened.push(db);
  return db;
}

/** Removes what migrations 17 to 22 add, so a test can rewind the version past them. */
function undoAfter16(db: Database.Database) {
  undoUsage(db);
  db.exec(
    "DROP TABLE plan_sessions; ALTER TABLE plans DROP COLUMN archived_at; ALTER TABLE jobs DROP COLUMN fallback_json;",
  );
  db.exec(
    "DROP TRIGGER cards_search_stale; DROP INDEX cards_search_pending; ALTER TABLE cards DROP COLUMN search_text; ALTER TABLE messages DROP COLUMN figures_json;",
  );
  db.exec("ALTER TABLE plan_sources DROP COLUMN role; ALTER TABLE plan_sources DROP COLUMN paper_json;");
  const before = ["jobs_state", "messages_chat", "passages_source", "learning_events_plan", "job_steps_job", "gap_answers_attempt"];
  const added = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .pluck()
    .all() as string[];
  for (const name of added.filter((name) => !before.includes(name))) db.exec(`DROP INDEX ${name}`);
}

/** Removes what migration 32 adds, so a test can rewind the version past it. */
function undoLessonParts(db: Database.Database) {
  db.exec("DROP TABLE lesson_parts; DROP TABLE lesson_outlines;");
}

/** Removes what migrations 29 to 32 add, so a test can rewind the version past them. */
function undoSubjectSort(db: Database.Database) {
  undoLessonParts(db);
  db.exec("ALTER TABLE sources DROP COLUMN chosen_kind; DROP INDEX sources_blob_sha; DROP INDEX sources_subject_sort; ALTER TABLE sources DROP COLUMN subject_sort;");
}

/**
 * Puts `cards` back as it was before migration 28 (and removes migration 29 after it): an exam on every card, no subject
 * and no subject triggers.
 */
function undoCardSubjects(db: Database.Database) {
  undoSubjectSort(db);
  db.pragma("foreign_keys = OFF");
  db.exec(`DROP TRIGGER plans_subject_to_cards;
CREATE TABLE cards_before (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
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
  search_text TEXT
);
DROP TABLE cards;
ALTER TABLE cards_before RENAME TO cards;
CREATE INDEX cards_plan ON cards(plan_id, topic_id);
CREATE INDEX cards_topic ON cards(topic_id);
CREATE INDEX cards_passage ON cards(passage_id);
CREATE INDEX cards_search_pending ON cards(id) WHERE search_text IS NULL;
CREATE TRIGGER cards_search_stale AFTER UPDATE OF front, back ON cards BEGIN
  UPDATE cards SET search_text = NULL WHERE id = new.id;
END;`);
  db.pragma("foreign_keys = ON");
}

/** Puts `maps` back as it was before migration 26: no subject, an exam on every row, and no triggers. */
function undoMapSubjects(db: Database.Database) {
  undoCardSubjects(db);
  db.exec(`DROP TRIGGER plans_subject_to_maps;
CREATE TABLE maps_before (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
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
DROP TABLE maps;
ALTER TABLE maps_before RENAME TO maps;
CREATE INDEX maps_plan ON maps(plan_id);
CREATE INDEX maps_topic ON maps(topic_id);`);
}

/** Removes what migration 24 adds, the linked-folder tables with migration 25's columns, and migration 26 after them. */
function undoLinked(db: Database.Database) {
  undoMapSubjects(db);
  db.exec("DROP TABLE linked_files; DROP TABLE linked_subfolders; DROP TABLE linked_folders;");
}

/** Removes what migration 21 adds, and migration 24 after it, so the version can go back past both. */
function undoUsage(db: Database.Database) {
  undoLinked(db);
  db.exec(
    "DROP TABLE engine_usage; ALTER TABLE messages DROP COLUMN error; ALTER TABLE messages DROP COLUMN passages_json;",
  );
}

afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});

describe("migrate", () => {
  it("refuses a workspace written by a newer version", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.pragma("user_version = 1000");
    db.close();
    expect(() => openDatabase(file)).toThrow("workspace-newer");
  });

  it("creates every table once and keeps rows on a second open", () => {
    const dir = tempDir("pyxis-db-");
    const file = join(dir, "pyxis.db");
    const db = openDatabase(file);
    opened.push(db);
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of [
      "profile",
      "settings",
      "engines",
      "feature_engines",
      "subjects",
      "sources",
      "source_documents",
      "passages",
      "passages_fts",
      "passages_vec",
      "smartbooks",
      "exercises",
      "plans",
      "plan_sources",
      "topics",
      "topic_passages",
      "path_nodes",
      "items",
      "item_passages",
      "cards",
      "card_reviews",
      "attempts",
      "attempt_answers",
      "gaps",
      "gap_items",
      "gap_answers",
      "maps",
      "chats",
      "messages",
      "message_passages",
      "attachments",
      "whiteboards",
      "flags",
      "learning_events",
      "jobs",
      "job_steps",
      "engine_usage",
      "linked_folders",
      "linked_subfolders",
      "linked_files",
      "lesson_outlines",
      "lesson_parts",
    ]) {
      expect(names).toContain(table);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(32);
    const id = uuidv7();
    db.prepare(
      `INSERT INTO subjects (id, name, created_at) VALUES (?, ?, ?)`,
    ).run(id, "Fisica", 1);
    db.close();
    opened.pop();
    const again = openDatabase(file);
    opened.push(again);
    const row = again
      .prepare(`SELECT name FROM subjects WHERE id = ?`)
      .get(id) as {
      name: string;
    };
    expect(row.name).toBe("Fisica");
    expect(again.pragma("user_version", { simple: true })).toBe(32);
  });

  it("adds the free-book catalog link to sources, empty for sources that already exist", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.pragma("user_version = 15");
    undoAfter16(db);
    db.exec(
      "ALTER TABLE sources DROP COLUMN catalog_id; ALTER TABLE sources DROP COLUMN catalog_version;",
    );
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('book', 'smartbook', 'Libro', 'ready', 1, 1)`,
    ).run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      again
        .prepare(
          "SELECT catalog_id, catalog_version FROM sources WHERE id = 'book'",
        )
        .get(),
    ).toEqual({
      catalog_id: null,
      catalog_version: null,
    });
  });

  it("adds figure images to messages, empty for messages that already exist, and only as JSON", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.pragma("user_version = 18");
    db.exec(
      "ALTER TABLE messages DROP COLUMN figures_json; ALTER TABLE plan_sources DROP COLUMN role; ALTER TABLE plan_sources DROP COLUMN paper_json; DROP TABLE plan_sessions; ALTER TABLE plans DROP COLUMN archived_at; ALTER TABLE jobs DROP COLUMN fallback_json;",
    );
    undoUsage(db);
    db.prepare(
      `INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat', 'Fisica', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('old', 'chat', 'assistant', 'Risposta', 1)`,
    ).run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      again.prepare("SELECT figures_json FROM messages WHERE id = 'old'").get(),
    ).toEqual({ figures_json: null });
    expect(() =>
      again
        .prepare(
          `INSERT INTO messages (id, chat_id, role, body, figures_json, created_at) VALUES ('bad', 'chat', 'assistant', 'x', 'not json', 2)`,
        )
        .run(),
    ).toThrow();
  });

  it("adds the failure key to messages and the token usage table, keeping messages that already exist", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.exec("DROP TABLE plan_sessions; ALTER TABLE plans DROP COLUMN archived_at; ALTER TABLE jobs DROP COLUMN fallback_json;");
    db.pragma("user_version = 20");
    undoUsage(db);
    db.prepare(
      `INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat', 'Fisica', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('old', 'chat', 'assistant', 'Risposta', 1)`,
    ).run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      again.prepare("SELECT error, passages_json FROM messages WHERE id = 'old'").get(),
    ).toEqual({ error: null, passages_json: null });
    expect(
      again.prepare("SELECT COUNT(*) AS n FROM engine_usage").get(),
    ).toEqual({ n: 0 });
  });

  it("inserts and queries a vector", () => {
    const db = tempDb();
    const id = uuidv7();
    db.prepare(
      `INSERT INTO passages (id, text, created_at) VALUES (?, ?, ?)`,
    ).run(id, "la velocità è derivata dello spazio", 1);
    const row = db
      .prepare(`SELECT rowid AS n FROM passages WHERE id = ?`)
      .get(id) as {
      n: number;
    };
    const vector = new Float32Array(384);
    vector[0] = 1;
    const bytes = Buffer.from(vector.buffer);
    db.prepare(
      `INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`,
    ).run(BigInt(row.n), bytes);
    const found = db
      .prepare(
        `SELECT passage_rowid AS n, distance FROM passages_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT 1`,
      )
      .get(bytes) as { n: number; distance: number };
    expect(found.n).toBe(row.n);
    expect(found.distance).toBe(0);
  });
});

describe("linked folders", () => {
  it("adds the linked-folder tables and leaves every source as it was", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    undoLinked(db);
    db.pragma("user_version = 23");
    db.prepare(
      "INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'abc', 'application/pdf', 'ready', 1, 2)",
    ).run();
    const before = db.prepare("SELECT * FROM sources").all();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    // Migration 29 adds an empty `subject_sort` and 31 an empty `chosen_kind`; nothing else of the source changes.
    expect(again.prepare("SELECT * FROM sources").all()).toEqual(
      (before as Array<Record<string, unknown>>).map((row) => ({ ...row, subject_sort: null, chosen_kind: null })),
    );
    expect(again.prepare("SELECT COUNT(*) AS n FROM linked_files").get()).toEqual({ n: 0 });
    again.prepare("INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('f', '/study', 'root', 1)").run();
    again.prepare(
      "INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms) VALUES ('f', 'a.pdf', '', 's', 1, 1)",
    ).run();
    // Deleting a source keeps its file recorded, with no source, so it is not read again.
    again.prepare("DELETE FROM sources WHERE id = 's'").run();
    expect(again.prepare("SELECT source_id FROM linked_files").get()).toEqual({ source_id: null });
    expect(() =>
      again.prepare("INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('g', '/other', 'drive', 1)").run(),
    ).toThrow();
  });
});

describe("linked folders read in full", () => {
  it("keeps every recorded file as read, and adds the waiting and sorting columns", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.exec(
      "DROP INDEX linked_files_hash; DROP INDEX linked_files_pending; DROP INDEX linked_files_gone; ALTER TABLE linked_files DROP COLUMN pending; ALTER TABLE linked_files DROP COLUMN sorted_at;",
    );
    undoMapSubjects(db);
    db.pragma("user_version = 24");
    db.prepare("INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('f', '/study', 'root', 1)").run();
    db.prepare(
      "INSERT INTO linked_files (folder_id, rel_path, subfolder, size, mtime_ms) VALUES ('f', 'a.pdf', '', 1, 1)",
    ).run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(again.prepare("SELECT pending, sorted_at FROM linked_files").get()).toEqual({ pending: 0, sorted_at: null });
    expect(() => again.prepare("UPDATE linked_files SET pending = 3").run()).toThrow();
    // The queue finds waiting files of a folder through its own index.
    const plan = again
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM linked_files WHERE folder_id = 'f' AND pending > 0 ORDER BY rowid")
      .all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("linked_files_pending");
  });
});

describe("the linked-file hash lookup", () => {
  it("reads a hash through its own index, for files that are present", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.exec("DROP INDEX linked_files_hash");
    undoCardSubjects(db);
    db.pragma("user_version = 26");
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    // The two queries the import and the folder scan run: a hash among present files, alone and next to a source's own hash.
    for (const sql of [
      "SELECT source_id FROM linked_files WHERE content_hash = 'abc' AND missing_at IS NULL",
      `SELECT id FROM sources WHERE blob_sha = 'abc'
         OR id IN (SELECT source_id FROM linked_files WHERE content_hash = 'abc' AND missing_at IS NULL)`,
    ]) {
      const plan = (again.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(" | ");
      expect(plan).toContain("linked_files_hash");
    }
  });
});

describe("maps by subject", () => {
  it("gives every map its exam's subject, keeps a map whose exam has none, and lets a map have no exam", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.exec("DROP INDEX linked_files_hash");
    undoMapSubjects(db);
    db.pragma("user_version = 25");
    db.exec(`
      INSERT INTO subjects (id, name, position, created_at) VALUES ('phys', 'Fisica I', 0, 1);
      INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES
        ('p', 'phys', 'Meccanica', 'ready', 1, 1), ('loose', NULL, 'Appunti', 'ready', 1, 1);
      INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Moto', 0, 1), ('u', 'loose', 'Varie', 0, 1);
      INSERT INTO maps (id, plan_id, topic_id, graph_json, grounding, prompt_version, created_at) VALUES
        ('m', 'p', 't', '{"version":1,"maps":[]}', 'sources', '3', 7),
        ('n', 'loose', 'u', '{"version":1,"maps":[]}', 'general', NULL, 8);
    `);
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(
      again.prepare("SELECT id, subject_id, plan_id, topic_id, grounding, prompt_version, created_at FROM maps ORDER BY id").all(),
    ).toEqual([
      { id: "m", subject_id: "phys", plan_id: "p", topic_id: "t", grounding: "sources", prompt_version: "3", created_at: 7 },
      { id: "n", subject_id: null, plan_id: "loose", topic_id: "u", grounding: "general", prompt_version: null, created_at: 8 },
    ]);
    expect(again.pragma("foreign_key_check")).toEqual([]);
    // A whole subject's map has no exam and no topic, and a subject has one such row.
    again.prepare(
      "INSERT INTO maps (id, subject_id, graph_json, created_at) VALUES ('whole', 'phys', '{\"version\":1,\"maps\":[]}', 9)",
    ).run();
    expect(() =>
      again.prepare(
        "INSERT INTO maps (id, subject_id, graph_json, created_at) VALUES ('twice', 'phys', '{\"version\":1,\"maps\":[]}', 9)",
      ).run(),
    ).toThrow();
    // A topic map follows its exam's subject, set when it is written and whenever the exam changes subject.
    again.prepare("UPDATE plans SET subject_id = 'phys' WHERE id = 'loose'").run();
    again.prepare(
      "INSERT INTO maps (id, plan_id, topic_id, graph_json, created_at) VALUES ('o', 'loose', 'u', '{\"version\":1,\"maps\":[]}', 10)",
    ).run();
    expect(again.prepare("SELECT id, subject_id FROM maps ORDER BY id").all()).toEqual([
      { id: "m", subject_id: "phys" },
      { id: "n", subject_id: "phys" },
      { id: "o", subject_id: "phys" },
      { id: "whole", subject_id: "phys" },
    ]);
  });
});

describe("past paper role", () => {
  it("keeps every existing plan source as study material", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.exec(
      "ALTER TABLE plan_sources DROP COLUMN role; ALTER TABLE plan_sources DROP COLUMN paper_json; DROP TABLE plan_sessions; ALTER TABLE plans DROP COLUMN archived_at; ALTER TABLE jobs DROP COLUMN fallback_json;",
    );
    undoUsage(db);
    db.pragma("user_version = 19");
    db.prepare(
      "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1)",
    ).run();
    db.prepare("INSERT INTO plan_sources (plan_id, source_id) VALUES ('p', 's')").run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(again.prepare("SELECT role, paper_json FROM plan_sources").get()).toEqual({
      role: "material",
      paper_json: null,
    });
    expect(() =>
      again.prepare("UPDATE plan_sources SET role = 'exam'").run(),
    ).toThrow();
  });
});

/** A workspace as an earlier release left it: the same steps, stopped at `version`. Steps are only ever appended. */
function workspaceAt(version: number): { db: Database.Database; file: string } {
  const file = join(tempDir("pyxis-db-"), "pyxis.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.loadExtension(getLoadablePath());
  migrate(db, version);
  expect(db.pragma("user_version", { simple: true })).toBe(version);
  return { db, file };
}

/**
 * Cards in two subjects' exams, in an exam with no subject, with and without a topic; reviewed, suspended, removed,
 * seeded and hand-made; two made in the same millisecond, where the rowid decides the order; with reviews and events.
 */
function seedCards(db: Database.Database) {
  db.exec(`
    INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica I', 1), ('math', 'Analisi 1', 1);
    INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES
      ('p', 'phys', 'Meccanica', 'ready', 1, 1), ('q', 'math', 'Limiti', 'ready', 1, 1),
      ('loose', NULL, 'Appunti', 'ready', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES
      ('t1', 'p', 'Moto', 0, 1), ('t2', 'p', 'Forze', 1, 1), ('u1', 'q', 'Successioni', 0, 1),
      ('v1', 'loose', 'Varie', 0, 1);
    INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1);
    INSERT INTO passages (rowid, id, source_id, text, section_path, created_at) VALUES
      (1, 'ps', 's', 'F = ma', '2.1 Newton', 1);
    INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, passage_id, seed_key, created_at) VALUES
      ('c9', 'p', 't1', 'Velocità?', 'dx/dt', 'sources', 'ps', 'gen:velocita', 100),
      ('c1', 'p', 't1', 'Accelerazione?', 'dv/dt', 'sources', NULL, 'gen:accelerazione', 100),
      ('c5', 'p', 't2', 'Seconda legge?', 'F = ma', 'sources', 'ps', 'gen:newton', 101),
      ('c3', 'p', NULL, 'Senza argomento', 'resta', 'general', NULL, NULL, 102),
      ('c7', 'q', 'u1', '{{c1::Cauchy}} converge', 'sì', 'general', NULL, 'text:cauchy', 103),
      ('c2', 'loose', 'v1', 'Unità di misura', 'SI', 'general', NULL, NULL, 104),
      ('c8', 'loose', 'v1', 'Rimossa', 'sì', 'general', NULL, 'gen:rimossa', 105);
    UPDATE cards SET suspended = 1 WHERE id = 'c5';
    UPDATE cards SET removed = 1 WHERE id = 'c8';
    UPDATE cards SET engine_provider = 'claude', model_id = 'm', model_source = 'reported',
      prompt_template = 'cards.generate', prompt_version = '4' WHERE id = 'c9';
    INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES
      ('r1', 'c9', 'good', '{"dueAt":5000,"intervalDays":3,"ease":2.5}', 200),
      ('r2', 'c9', 'again', '{"dueAt":300,"intervalDays":0,"ease":2.3}', 200),
      ('r3', 'c7', 'easy', '{"dueAt":9000,"intervalDays":9,"ease":2.6}', 201),
      ('r4', 'c2', 'hard', '{"dueAt":400,"intervalDays":1,"ease":2.4}', 202),
      ('r5', 'c8', 'good', '{"dueAt":800,"intervalDays":2,"ease":2.5}', 203);
    INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES
      ('e1', 'card_rated', 'p', 't1', '{"score":1,"cardId":"c9"}', 200),
      ('e2', 'card_rated', 'q', 'u1', '{"score":1,"cardId":"c7"}', 201);
  `);
  // Present from version 18 on: the folded text the browser searches.
  const columns = (db.prepare("SELECT name FROM pragma_table_info('cards')").pluck().all() as string[]);
  if (columns.includes("search_text")) db.exec("UPDATE cards SET search_text = lower(front) WHERE id <> 'c3'");
}

const snapshot = (db: Database.Database) => ({
  cards: db.prepare("SELECT rowid AS r, * FROM cards ORDER BY id").all() as Array<Record<string, unknown>>,
  order: db.prepare("SELECT id FROM cards ORDER BY created_at, rowid").pluck().all(),
  reviews: db.prepare("SELECT rowid AS r, * FROM card_reviews ORDER BY id").all(),
  events: db.prepare("SELECT * FROM learning_events ORDER BY id").all(),
});

describe("flashcards by subject", () => {
  for (const [release, version] of [
    ["0.4.x", 23],
    ["0.5.0-dev.7", 26],
    ["a build of next with the linked-file index but not this change", 27],
  ] as const)
    it(`keeps every card of a ${release} workspace with its reviews, and gives each its exam's subject`, () => {
      const { db, file } = workspaceAt(version);
      seedCards(db);
      const before = snapshot(db);
      expect(before.cards).toHaveLength(7);
      db.close();

      const again = openDatabase(file);
      opened.push(again);
      expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(again.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(again.pragma("foreign_key_check")).toEqual([]);
      // Migration 27's index is there whichever step created it, and only once.
      expect(
        again.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'linked_files_hash'").pluck().get(),
      ).toBe(1);
      const after = snapshot(again);
      // Every column of every card is unchanged, rowid included, and only the subject is new.
      expect(after.cards.map(({ subject_id: _, ...card }) => card)).toEqual(before.cards);
      expect(Object.fromEntries(after.cards.map((card) => [card.id, card.subject_id]))).toEqual({
        c1: "phys",
        c2: null,
        c3: "phys",
        c5: "phys",
        c7: "math",
        c8: null,
        c9: "phys",
      });
      expect(after.order).toEqual(before.order);
      expect(after.reviews).toEqual(before.reviews);
      expect(after.events).toEqual(before.events);
      // The table's indexes and triggers are back, and the search text still clears when a face changes.
      const names = again
        .prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'cards' AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name")
        .pluck()
        .all();
      expect(names).toEqual([
        "cards_follow_plan",
        "cards_passage",
        "cards_plan",
        "cards_search_pending",
        "cards_search_stale",
        "cards_subject",
        "cards_take_plan_subject",
        "cards_topic",
      ]);
      again.prepare("UPDATE cards SET front = 'Velocità media?' WHERE id = 'c9'").run();
      expect(again.prepare("SELECT search_text FROM cards WHERE id = 'c9'").pluck().get()).toBeNull();

      // Deleting an exam still deletes its cards and their reviews, and nothing else.
      again.prepare("DELETE FROM plans WHERE id = 'p'").run();
      expect(again.prepare("SELECT id FROM cards ORDER BY id").pluck().all()).toEqual(["c2", "c7", "c8"]);
      expect(again.prepare("SELECT id FROM card_reviews ORDER BY id").pluck().all()).toEqual(["r3", "r4", "r5"]);
      expect(again.pragma("foreign_key_check")).toEqual([]);
    });

  it("files a card under a subject with no exam, and keeps an exam's cards on the exam's subject", () => {
    const db = tempDb();
    seedCards(db);
    // A card with no exam needs a subject only by convention; a topic without an exam is refused.
    db.prepare("INSERT INTO cards (id, subject_id, front, back, created_at) VALUES ('free', 'phys', 'Lavoro?', 'F·s', 1)").run();
    expect(() =>
      db.prepare("INSERT INTO cards (id, subject_id, topic_id, front, back, created_at) VALUES ('bad', 'phys', 't1', 'x', 'y', 1)").run(),
    ).toThrow();
    // Written under an exam, a card takes the exam's subject whatever the insert says, and follows the exam.
    db.prepare("INSERT INTO cards (id, plan_id, topic_id, subject_id, front, back, created_at) VALUES ('new', 'q', 'u1', 'phys', 'x', 'y', 1)").run();
    expect(db.prepare("SELECT subject_id FROM cards WHERE id = 'new'").pluck().get()).toBe("math");
    db.prepare("UPDATE plans SET subject_id = 'phys' WHERE id = 'loose'").run();
    expect(db.prepare("SELECT id FROM cards WHERE subject_id = 'phys' ORDER BY id").pluck().all()).toEqual([
      "c1", "c2", "c3", "c5", "c8", "c9", "free",
    ]);
    // Removing a subject leaves its cards, exam or not, with no subject; none is deleted.
    db.prepare("DELETE FROM subjects WHERE id = 'phys'").run();
    expect(db.prepare("SELECT COUNT(*) FROM cards WHERE subject_id IS NULL").pluck().get()).toBe(7);
    expect(db.prepare("SELECT COUNT(*) FROM cards").pluck().get()).toBe(9);
  });

  it("keeps an old broken reference as it was, logs it once without card text, and starts", () => {
    const { db, file } = workspaceAt(26);
    seedCards(db);
    // References that broke before this upgrade (written with checks off): a card's passage and a review's card.
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE cards SET passage_id = 'ghost' WHERE id = 'c1'").run();
    db.prepare("INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('orphan', 'gone', 'good', '{}', 1)").run();
    db.pragma("foreign_keys = ON");
    const before = snapshot(db);
    expect(db.pragma("foreign_key_check")).toHaveLength(2);
    db.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(again.pragma("foreign_keys", { simple: true })).toBe(1);
    // Every card and review is still there, unchanged but for the new subject column; the old references are untouched.
    const after = snapshot(again);
    expect(after.cards.map(({ subject_id: _, ...card }) => card)).toEqual(before.cards);
    expect(after.reviews).toEqual(before.reviews);
    expect(after.events).toEqual(before.events);
    expect(again.prepare("SELECT passage_id FROM cards WHERE id = 'c1'").pluck().get()).toBe("ghost");
    expect(again.pragma("foreign_key_check")).toHaveLength(2);
    // One note, naming how many and where, and none of the card text.
    const notes = warn.mock.calls.map((call) => call.join(" "));
    warn.mockRestore();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("cards");
    expect(notes[0]).toContain("card_reviews");
    expect(notes[0]).not.toContain("Accelerazione");
  });

  it("rolls the whole upgrade back when the rebuild itself breaks a reference, and switches foreign keys on again", () => {
    const { db, file } = workspaceAt(26);
    seedCards(db);
    // An exam that points at a subject that is gone (written with checks off): each of its cards would take that
    // subject, so the rebuilt table would hold references that did not exist in the old one.
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE plans SET subject_id = 'vanished' WHERE id = 'q'").run();
    db.pragma("foreign_keys = ON");
    const before = snapshot(db);
    db.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => openDatabase(file)).toThrow("migrate-broken-references:cards");
    warn.mockRestore();
    const raw = new Database(file);
    opened.push(raw);
    expect(raw.pragma("user_version", { simple: true })).toBe(26);
    // Migration 27 ran in the same transaction, so its index is gone again too.
    expect(raw.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'linked_files_hash'").pluck().get()).toBe(0);
    expect(snapshot(raw)).toEqual(before);
    // The failed upgrade left foreign keys on for the next open.
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("the subject Pyxis chooses for a Library file", () => {
  it("leaves every existing source unsorted, and takes only the known states", () => {
    const { db, file } = workspaceAt(28);
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 2)",
    ).run();
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(again.prepare("SELECT subject_sort FROM sources").get()).toEqual({ subject_sort: null });
    again.prepare("UPDATE sources SET subject_sort = 'waiting'").run();
    expect(() => again.prepare("UPDATE sources SET subject_sort = 'guessed'").run()).toThrow();
  });
});

describe("the index on a source's stored file", () => {
  for (const [release, version] of [
    ["0.4.x", 23],
    ["0.5.0-dev.7", 26],
    ["a build of next with the linked-file index", 27],
    ["a build of next before the subject sort", 28],
    ["0.5.0-dev.8", 29],
  ] as const)
    it(`keeps every source of a ${release} workspace as it was and adds the index once`, () => {
      const { db, file } = workspaceAt(version);
      db.exec(`
        INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at) VALUES
          ('a', 'pdf', 'Dispense', 'abc', 'application/pdf', 'ready', 1, 2),
          ('b', 'pdf', 'Copia', 'abc', 'application/pdf', 'ready', 3, 4),
          ('c', 'text', 'Appunti', NULL, NULL, 'ready', 5, 6);
      `);
      const before = db.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
      db.close();

      const again = openDatabase(file);
      opened.push(again);
      expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(again.pragma("integrity_check", { simple: true })).toBe("ok");
      // Every row is unchanged. Migration 29 adds an empty `subject_sort` to a workspace older than it, and 31 an empty
      // `chosen_kind`.
      const after = again.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
      expect(after).toEqual(
        before.map((row) => ({ ...row, ...(version < 29 ? { subject_sort: null } : {}), chosen_kind: null })),
      );
      expect(
        again.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'sources_blob_sha'").pluck().get(),
      ).toBe(1);
      // The index holds the rows that have a stored file and none of the others.
      const rows = again
        .prepare("SELECT id FROM sources INDEXED BY sources_blob_sha WHERE blob_sha IS NOT NULL ORDER BY id")
        .pluck()
        .all();
      expect(rows).toEqual(["a", "b"]);
    });
});

describe("the kind a student chose for a file", () => {
  it("upgrades a 0.5.0-dev.9 workspace with its files as they were and no kind chosen", () => {
    const { db, file } = workspaceAt(30);
    db.exec(`
      INSERT INTO subjects (id, name, created_at) VALUES ('fis', 'Fisica 2', 1);
      INSERT INTO sources (id, subject_id, kind, title, blob_sha, mime, status, subject_sort, created_at, updated_at) VALUES
        ('a', 'fis', 'pdf', 'Temi d''esame 2022-2025', 'abc', 'application/pdf', 'ready', 'manual', 1, 2),
        ('b', NULL, 'image', 'IMG_2041', 'def', 'image/jpeg', 'ready', 'unsure', 3, 4),
        ('c', 'fis', 'smartbook', 'Fisica 2', NULL, NULL, 'ready', NULL, 5, 6);
    `);
    const before = db.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
    db.close();

    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(again.pragma("integrity_check", { simple: true })).toBe("ok");
    const after = again.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
    expect(after).toEqual(before.map((row) => ({ ...row, chosen_kind: null })));
    // The column takes a choice and gives it back.
    again.prepare("UPDATE sources SET chosen_kind = 'notes' WHERE id = 'a'").run();
    expect(again.prepare("SELECT chosen_kind FROM sources WHERE id = 'a'").pluck().get()).toBe("notes");
  });
});

/** How many columns of `sources` carry this name. */
const sourceColumns = (db: Database.Database, name: string) =>
  db.prepare("SELECT COUNT(*) FROM pragma_table_info('sources') WHERE name = ?").pluck().get(name);

describe("`sources.chosen_kind` on a new workspace and on every upgrade", () => {
  it("creates a new workspace at the newest version with the column once, empty for a new file", () => {
    const db = tempDb();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(sourceColumns(db, "chosen_kind")).toBe(1);
    db.prepare("INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('a', 'pdf', 'Dispense', 'ready', 1, 1)").run();
    expect(db.prepare("SELECT chosen_kind FROM sources WHERE id = 'a'").pluck().get()).toBeNull();
    // Opening it again runs no step and leaves the column as it is.
    migrate(db);
    expect(sourceColumns(db, "chosen_kind")).toBe(1);
  });

  // Each version is built by running the real steps up to it, so a step that already held the column would fail here.
  for (const version of [1, 15, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30])
    it(`upgrades a workspace at version ${version} to ${SCHEMA_VERSION} with every source kept and no kind chosen`, () => {
      const { db, file } = workspaceAt(version);
      expect(sourceColumns(db, "chosen_kind")).toBe(0);
      db.exec(`
        INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES
          ('a', 'pdf', 'Dispense', 'ready', 1, 2),
          ('b', 'text', 'Appunti', 'ready', 3, 4);
      `);
      const before = db.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
      db.close();

      const again = openDatabase(file);
      opened.push(again);
      expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(again.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(sourceColumns(again, "chosen_kind")).toBe(1);
      const after = again.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
      // Every value the row had is unchanged, and the new column is empty.
      expect(after.map((row) => Object.fromEntries(Object.keys(before[0]!).map((key) => [key, row[key]])))).toEqual(before);
      expect(after.map((row) => row.chosen_kind)).toEqual([null, null]);
    });
});

/**
 * A plan as the lesson reader leaves it before parts exist: a lesson with figures and citations, a book-text lesson,
 * quick check and recap answers, the lesson step, an opened lesson, a flashcard with a review and a quiz attempt.
 * Uses only columns every version has.
 */
function seedLessonWork(db: Database.Database) {
  db.exec(`
    INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Analisi 2', 'ready', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES
      ('t1', 'p', 'Funzioni di più variabili', 0, 1), ('t2', 'p', 'Integrali doppi', 1, 1);
    INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1);
    INSERT INTO passages (rowid, id, source_id, text, section_path, created_at) VALUES
      (1, 'ps1', 's', 'Per parlare di limiti in più variabili serve una distanza.', '2.1 Intorni', 1),
      (2, 'ps2', 's', 'Un insieme è aperto se ogni punto ha un intorno contenuto.', '2.2 Aperti e chiusi', 2);
    INSERT INTO topic_passages (topic_id, passage_id) VALUES ('t1', 'ps1'), ('t1', 'ps2');
    INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, model_id, model_source,
        prompt_template, prompt_version, grounding, created_at) VALUES
      ('lesson', 'p', 't1', 'lesson',
        '{"cacheKey":"{\\"kind\\":\\"lesson\\"}","markdown":"## Intorni\\n\\nTesto.","passageIds":["ps1","ps2"],"figures":{"f1":"data:image/png;base64,AA=="}}',
        'claude', 'm', 'reported', 'lesson.write', 'smart-4', 'sources', 10),
      ('book', 'p', 't2', 'lesson', '{"cacheKey":"book","markdown":"Testo del libro.","passageIds":[]}',
        NULL, NULL, NULL, NULL, NULL, 'sources', 11),
      ('quiz', 'p', 't1', 'quiz', '{"questions":[{"id":"q1","stem":"?"}]}', NULL, NULL, NULL, NULL, NULL, 'sources', 12);
    INSERT INTO item_passages (item_id, passage_id) VALUES ('lesson', 'ps1'), ('lesson', 'ps2');
    INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('a', 'p', 'quiz', 20, 21);
    INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES ('c', 'p', 't1', 'Intorno?', 'Una palla', 30);
    INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('r', 'c', 'good', '{"dueAt":5}', 31);
    INSERT INTO learning_events (id, kind, plan_id, topic_id, item_id, payload_json, created_at) VALUES
      ('e1', 'lesson_opened', 'p', 't1', 'lesson', '{}', 40),
      ('e2', 'answer_given', 'p', 't1', 'lesson', '{"score":1,"evidenceKind":"check","blockId":"b1","pick":0}', 41),
      ('e3', 'answer_given', 'p', 't1', 'lesson', '{"score":0,"evidenceKind":"check","blockId":"recap-1","pick":2}', 42),
      ('e4', 'lesson_completed', 'p', 't1', NULL, '{"activity":"lesson","itemId":"lesson"}', 43),
      ('e5', 'card_rated', 'p', 't1', NULL, '{"score":1,"cardId":"c"}', 44);
  `);
}

/** Every row of the tables the lesson reader, the path and progress read, in a stable order. */
const lessonSnapshot = (db: Database.Database) =>
  Object.fromEntries(
    ["plans", "topics", "passages", "topic_passages", "items", "item_passages", "attempts", "cards", "card_reviews", "learning_events"].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>],
    ),
  );

/** The schema objects one table owns, by name and SQL. */
const objectsOf = (db: Database.Database, tables: string[]) =>
  db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN (${tables.map(() => "?").join(",")}) ORDER BY type, name`,
    )
    .all(...tables) as Array<{ type: string; name: string; sql: string | null }>;

const PART_OBJECTS = [
  { type: "index", name: "lesson_outlines_live" },
  { type: "index", name: "lesson_outlines_plan" },
  { type: "index", name: "lesson_outlines_replaces" },
  { type: "index", name: "lesson_outlines_topic" },
  { type: "index", name: "lesson_parts_item" },
  { type: "index", name: "sqlite_autoindex_lesson_outlines_1" },
  { type: "index", name: "sqlite_autoindex_lesson_parts_1" },
  { type: "index", name: "sqlite_autoindex_lesson_parts_2" },
  { type: "table", name: "lesson_outlines" },
  { type: "table", name: "lesson_parts" },
];

describe("lesson outlines and parts (migration 32)", () => {
  it("creates both tables and their indexes once on a new workspace, and a second run changes nothing", () => {
    const db = tempDb();
    expect(db.pragma("user_version", { simple: true })).toBe(32);
    const objects = objectsOf(db, ["lesson_outlines", "lesson_parts"]);
    expect(objects.map(({ type, name }) => ({ type, name }))).toEqual(PART_OBJECTS);
    migrate(db);
    expect(objectsOf(db, ["lesson_outlines", "lesson_parts"])).toEqual(objects);
    expect(db.pragma("user_version", { simple: true })).toBe(32);
  });

  // Each version is built by running the real steps up to it: 1 is the first release, 23 is 0.4.x, 26 0.5.0-dev.7,
  // 29 dev.8, 30 dev.9 and 31 the version dev.10 ships with.
  for (const version of [1, 15, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30, 31])
    it(`upgrades a workspace at version ${version} with every lesson, answer, step and flashcard as it was`, () => {
      const { db, file } = workspaceAt(version);
      expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'lesson_%'").pluck().get()).toBe(0);
      seedLessonWork(db);
      db.close();
      // The same workspace taken to 31 without this step is what every row must still read as.
      const reference = workspaceAt(version);
      seedLessonWork(reference.db);
      migrate(reference.db, 31);
      const before = lessonSnapshot(reference.db);
      reference.db.close();

      const again = openDatabase(file);
      opened.push(again);
      expect(again.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(again.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(again.pragma("foreign_key_check")).toEqual([]);
      expect(lessonSnapshot(again)).toEqual(before);
      expect(again.prepare("SELECT COUNT(*) FROM lesson_outlines").pluck().get()).toBe(0);
      expect(again.prepare("SELECT COUNT(*) FROM lesson_parts").pluck().get()).toBe(0);
      const objects = objectsOf(again, ["lesson_outlines", "lesson_parts"]);
      expect(objects.map(({ type, name }) => ({ type, name }))).toEqual(PART_OBJECTS);

      // Opening it again runs no step: same version, same schema, same rows.
      again.close();
      opened.pop();
      const third = openDatabase(file);
      opened.push(third);
      migrate(third);
      expect(third.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(objectsOf(third, ["lesson_outlines", "lesson_parts"])).toEqual(objects);
      expect(lessonSnapshot(third)).toEqual(before);
    });

  it("keeps one live outline per topic, parts in positions, and lets a source go whatever an unwritten part lists", () => {
    const db = tempDb();
    seedLessonWork(db);
    const outline = (id: string, topic: string, retired: number | null) =>
      db
        .prepare(
          "INSERT INTO lesson_outlines (id, plan_id, topic_id, passage_key, origin, created_at, retired_at) VALUES (?, 'p', ?, 'k', 'model', 1, ?)",
        )
        .run(id, topic, retired);
    const part = (id: string, outlineId: string, position: number, extra: Partial<Record<string, unknown>> = {}) =>
      db
        .prepare(
          `INSERT INTO lesson_parts (id, outline_id, position, kind, title, passage_ids_json, minutes, item_id)
           VALUES (@id, @outline, @position, @kind, @title, @passages, @minutes, @item)`,
        )
        .run({
          id,
          outline: outlineId,
          position,
          kind: "part",
          title: "Intorni",
          passages: '["ps1"]',
          minutes: 6,
          item: null,
          ...extra,
        });
    outline("o1", "t1", null);
    // A second live outline on the same topic is refused; a retired one beside it is fine.
    expect(() => outline("o2", "t1", null)).toThrow(/UNIQUE/);
    outline("old", "t1", 5);
    outline("o3", "t2", null);
    db.prepare("UPDATE lesson_outlines SET replaces_item_id = 'book' WHERE id = 'o3'").run();
    part("a", "o1", 1, { item: "lesson" });
    part("b", "o1", 2);
    expect(() => part("c", "o1", 2)).toThrow(/UNIQUE/);
    expect(() => part("d", "o1", 0)).toThrow(/CHECK/);
    expect(() => part("e", "o1", 3, { kind: "summary" })).toThrow(/CHECK/);
    expect(() => part("f", "o1", 3, { minutes: 0 })).toThrow(/CHECK/);
    expect(() => part("g", "o1", 3, { minutes: 31 })).toThrow(/CHECK/);
    expect(() => part("h", "o1", 3, { passages: "[ps1" })).toThrow(/CHECK/);
    part("r", "o1", 3, { kind: "recap", title: "Ripasso del capitolo", passages: "[]", minutes: 4 });
    // A part remembers that its last write failed or was cancelled until a write succeeds: a time, empty by default.
    expect(db.prepare("SELECT write_failed_at FROM lesson_parts WHERE id = 'b'").pluck().get()).toBeNull();
    db.prepare("UPDATE lesson_parts SET write_failed_at = 1800000000000 WHERE id = 'b'").run();
    expect(db.prepare("SELECT write_failed_at FROM lesson_parts WHERE id = 'b'").pluck().get()).toBe(1800000000000);
    expect(() => db.prepare("UPDATE lesson_parts SET write_failed_at = 'ieri' WHERE id = 'b'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE lesson_parts SET write_failed_at = 1.5 WHERE id = 'b'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE lesson_parts SET write_failed_at = NULL WHERE id = 'b'").run();
    expect(() =>
      db.prepare("UPDATE lesson_outlines SET origin = 'guessed' WHERE id = 'o3'").run(),
    ).toThrow(/CHECK/);

    // Deleting a written part's item leaves the part, unwritten.
    db.prepare("DELETE FROM learning_events WHERE item_id = 'lesson'").run();
    db.prepare("DELETE FROM item_passages WHERE item_id = 'lesson'").run();
    db.prepare("DELETE FROM items WHERE id = 'lesson'").run();
    expect(db.prepare("SELECT item_id FROM lesson_parts WHERE id = 'a'").pluck().get()).toBeNull();
    // Deleting the old lesson an outline replaced keeps the outline.
    db.prepare("DELETE FROM items WHERE id = 'book'").run();
    expect(db.prepare("SELECT replaces_item_id FROM lesson_outlines WHERE id = 'o3'").pluck().get()).toBeNull();
    // The parts list passages as JSON, so removing the passages and their source is not blocked by them.
    db.prepare("DELETE FROM topic_passages").run();
    db.prepare("DELETE FROM passages").run();
    db.prepare("DELETE FROM sources").run();
    expect(db.prepare("SELECT COUNT(*) FROM lesson_parts").pluck().get()).toBe(3);
    // A topic takes its outlines and their parts with it, and a plan takes the rest.
    db.prepare("DELETE FROM topics WHERE id = 't1'").run();
    expect(db.prepare("SELECT id FROM lesson_outlines").pluck().all()).toEqual(["o3"]);
    expect(db.prepare("SELECT COUNT(*) FROM lesson_parts").pluck().get()).toBe(0);
    db.prepare("DELETE FROM plans WHERE id = 'p'").run();
    expect(db.prepare("SELECT COUNT(*) FROM lesson_outlines").pluck().get()).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
