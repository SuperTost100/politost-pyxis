import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { cacheKey, loadLesson, saveLesson } from "./lesson";

function seedPlan(db: Database.Database): { planId: string; passageA: string; passageB: string } {
  const now = Date.now();
  const planId = uuidv7(now);
  db.prepare(
    `INSERT INTO plans (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(planId, "Test plan", now, now);

  const passageA = uuidv7(now + 1);
  const passageB = uuidv7(now + 2);
  const insertPassage = db.prepare(
    `INSERT INTO passages (id, version, text, created_at) VALUES (?, 1, ?, ?)`,
  );
  insertPassage.run(passageA, "alpha", now);
  insertPassage.run(passageB, "beta", now);

  return { planId, passageA, passageB };
}

describe("cacheKey", () => {
  it("is stable for the same inputs", () => {
    const input = {
      kind: "smart_text",
      scopeId: "topic-1",
      passageIds: ["p-b", "p-a"],
      promptVersion: "v3",
    };
    expect(cacheKey(input)).toBe(cacheKey(input));
  });

  it("ignores passage id order", () => {
    const base = {
      kind: "smart_text",
      scopeId: "topic-1",
      promptVersion: "v3",
    };
    expect(cacheKey({ ...base, passageIds: ["p-a", "p-b"] })).toBe(
      cacheKey({ ...base, passageIds: ["p-b", "p-a"] }),
    );
  });
});

describe("lesson cache", () => {
  it("saves and loads markdown with passage ids", () => {
    const db = openDatabase(":memory:");
    const { planId, passageA, passageB } = seedPlan(db);
    const key = cacheKey({
      kind: "smart_text",
      scopeId: "topic-1",
      passageIds: [passageA, passageB],
      promptVersion: "v1",
    });

    saveLesson(db, {
      planId,
      kind: "smart_text",
      key,
      markdown: "# Hello\n\n[P1]",
      passageIds: [passageA, passageB],
    });

    const loaded = loadLesson(db, { planId, kind: "smart_text", key });
    expect(loaded).toEqual({
      markdown: "# Hello\n\n[P1]",
      passageIds: [passageA, passageB].sort(),
    });

    const row = db
      .prepare(`SELECT grounding, body_json FROM items WHERE plan_id = ?`)
      .get(planId) as { grounding: string; body_json: string };
    expect(row.grounding).toBe("sources");
    expect(JSON.parse(row.body_json)).toEqual({ cacheKey: key, markdown: "# Hello\n\n[P1]" });
  });

  it("replaces body on the same key but keeps the row id", () => {
    const db = openDatabase(":memory:");
    const { planId, passageA } = seedPlan(db);
    const key = cacheKey({
      kind: "quiz",
      scopeId: "topic-2",
      passageIds: [passageA],
      promptVersion: "v1",
    });

    const firstId = saveLesson(db, {
      planId,
      kind: "quiz",
      key,
      markdown: "old",
      passageIds: [passageA],
    });
    const secondId = saveLesson(db, {
      planId,
      kind: "quiz",
      key,
      markdown: "new",
      passageIds: [passageA],
    });

    expect(secondId).toBe(firstId);
    expect(loadLesson(db, { planId, kind: "quiz", key })?.markdown).toBe("new");
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE plan_id = ?`)
      .get(planId) as { n: number };
    expect(count.n).toBe(1);
  });

  it("keeps a prior row when saving under a different key", () => {
    const db = openDatabase(":memory:");
    const { planId, passageA, passageB } = seedPlan(db);
    const keyA = cacheKey({
      kind: "smart_text",
      scopeId: "topic-1",
      passageIds: [passageA],
      promptVersion: "v1",
    });
    const keyB = cacheKey({
      kind: "smart_text",
      scopeId: "topic-1",
      passageIds: [passageB],
      promptVersion: "v1",
    });

    saveLesson(db, {
      planId,
      kind: "smart_text",
      key: keyA,
      markdown: "first",
      passageIds: [passageA],
    });
    saveLesson(db, {
      planId,
      kind: "smart_text",
      key: keyB,
      markdown: "second",
      passageIds: [passageB],
    });

    expect(loadLesson(db, { planId, kind: "smart_text", key: keyA })?.markdown).toBe("first");
    expect(loadLesson(db, { planId, kind: "smart_text", key: keyB })?.markdown).toBe("second");
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE plan_id = ?`)
      .get(planId) as { n: number };
    expect(count.n).toBe(2);
  });

  it("returns null when nothing is cached", () => {
    const db = openDatabase(":memory:");
    const { planId } = seedPlan(db);
    expect(
      loadLesson(db, {
        planId,
        kind: "smart_text",
        key: cacheKey({
          kind: "smart_text",
          scopeId: "missing",
          passageIds: [],
          promptVersion: "v0",
        }),
      }),
    ).toBeNull();
  });
});
