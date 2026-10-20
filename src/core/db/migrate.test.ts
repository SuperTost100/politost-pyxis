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

/** Removes what migrations 17 to 21 add, so a test can rewind the version past them. */
function undoAfter16(db: Database.Database) {
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

/** Removes what migration 21 adds. */
function undoUsage(db: Database.Database) {
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
    ]) {
      expect(names).toContain(table);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(21);
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
    expect(again.pragma("user_version", { simple: true })).toBe(21);
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
    expect(again.pragma("user_version", { simple: true })).toBe(21);
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
      "ALTER TABLE messages DROP COLUMN figures_json; ALTER TABLE plan_sources DROP COLUMN role; ALTER TABLE plan_sources DROP COLUMN paper_json;",
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
    expect(again.pragma("user_version", { simple: true })).toBe(21);
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
    expect(again.pragma("user_version", { simple: true })).toBe(21);
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

describe("past paper role", () => {
  it("keeps every existing plan source as study material", () => {
    const file = join(tempDir("pyxis-db-"), "pyxis.db");
    const db = openDatabase(file);
    db.exec(
      "ALTER TABLE plan_sources DROP COLUMN role; ALTER TABLE plan_sources DROP COLUMN paper_json;",
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
    expect(again.pragma("user_version", { simple: true })).toBe(21);
    expect(again.prepare("SELECT role, paper_json FROM plan_sources").get()).toEqual({
      role: "material",
      paper_json: null,
    });
    expect(() =>
      again.prepare("UPDATE plan_sources SET role = 'exam'").run(),
    ).toThrow();
  });
});
