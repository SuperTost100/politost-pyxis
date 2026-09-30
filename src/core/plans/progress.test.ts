import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { planMastery, planSeries } from "./progress";

describe("planMastery", () => {
  it("reads a finished lesson as full mastery for that topic", () => {
    const db = openDatabase(":memory:");
    const planId = uuidv7(1);
    const topicId = uuidv7(2);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Moti', 0, 1)`,
    ).run(topicId, planId);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'lesson_completed', ?, ?, '{}', ?)`,
    ).run(uuidv7(3), planId, topicId, Date.now());
    const rows = planMastery(db, planId);
    expect(rows).toEqual([{ id: topicId, title: "Moti", mastery: 1 }]);
  });

  it("stores an open gap from two misses in one quiz", () => {
    const db = openDatabase(":memory:");
    const planId = uuidv7(1);
    const topicId = uuidv7(2);
    const now = Date.UTC(2026, 0, 14, 12);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Moti', 0, 1)`,
    ).run(topicId, planId);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    ).run(uuidv7(3), planId, topicId, JSON.stringify({ score: 0, scores: [0, 0] }), now);
    const series = planSeries(db, planId, now);
    expect(series.chart).toHaveLength(14);
    expect(series.chart[13]?.count).toBe(1);
    expect(series.gaps).toEqual([{ topicId, openedAt: now }]);
    expect(series.pace.week).toBe(1);
    const again = planSeries(db, planId, now);
    expect(again.gaps).toHaveLength(1);
  });
});
