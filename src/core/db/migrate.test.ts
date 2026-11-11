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

/** Removes what migrations 29 and 30 add, so a test can rewind the version past them. */
function undoSubjectSort(db: Database.Database) {
  db.exec("DROP INDEX sources_blob_sha; DROP INDEX sources_subject_sort; ALTER TABLE sources DROP COLUMN subject_sort;");
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
    ]) {
      expect(names).toContain(table);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
    // Migration 29 adds an empty `subject_sort`; nothing else of the source changes.
    expect(again.prepare("SELECT * FROM sources").all()).toEqual(
      (before as Array<Record<string, unknown>>).map((row) => ({ ...row, subject_sort: null })),
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
    expect(again.pragma("user_version", { simple: true })).toBe(30);
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
      // Every row is unchanged. Migration 29 adds an empty `subject_sort` to a workspace older than it.
      const after = again.prepare("SELECT * FROM sources ORDER BY rowid").all() as Array<Record<string, unknown>>;
      expect(after).toEqual(version < 29 ? before.map((row) => ({ ...row, subject_sort: null })) : before);
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
