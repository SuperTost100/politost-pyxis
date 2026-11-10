import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "./connection";
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
  db.exec(
    "DROP TABLE plan_sessions; ALTER TABLE plans DROP COLUMN archived_at; ALTER TABLE jobs DROP COLUMN fallback_json;",
  );
  db.exec(
    "DROP TRIGGER cards_search_stale; DROP INDEX cards_search_pending; ALTER TABLE cards DROP COLUMN search_text; ALTER TABLE messages DROP COLUMN figures_json;",
  );
  undoUsage(db);
  db.exec("ALTER TABLE plan_sources DROP COLUMN role; ALTER TABLE plan_sources DROP COLUMN paper_json;");
  const before = ["jobs_state", "messages_chat", "passages_source", "learning_events_plan", "job_steps_job", "gap_answers_attempt"];
  const added = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .pluck()
    .all() as string[];
  for (const name of added.filter((name) => !before.includes(name))) db.exec(`DROP INDEX ${name}`);
}

/** Puts `maps` back as it was before migration 26: no subject, an exam on every row, and no triggers. */
function undoMapSubjects(db: Database.Database) {
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
    expect(db.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
    expect(again.prepare("SELECT * FROM sources").all()).toEqual(before);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    db.pragma("user_version = 26");
    db.close();
    const again = openDatabase(file);
    opened.push(again);
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
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
    expect(again.pragma("user_version", { simple: true })).toBe(27);
    expect(again.prepare("SELECT role, paper_json FROM plan_sources").get()).toEqual({
      role: "material",
      paper_json: null,
    });
    expect(() =>
      again.prepare("UPDATE plan_sources SET role = 'exam'").run(),
    ).toThrow();
  });
});
