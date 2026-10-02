import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./connection";
import { uuidv7 } from "../../shared/ids";

const opened: Array<{ close: () => void }> = [];

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-db-"));
  const db = openDatabase(join(dir, "pyxis.db"));
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened) db.close();
  opened.length = 0;
});

describe("migrate", () => {
  it("creates every table once and keeps rows on a second open", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-db-"));
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
    ]) {
      expect(names).toContain(table);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(12);
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
    expect(again.pragma("user_version", { simple: true })).toBe(12);
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
