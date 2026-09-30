import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { listPlans, nextLesson } from "./create";
import { planMastery, planSeries } from "./progress";
import { listSimulations } from "../study/simulation";

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

  it("lists a plan with its subject, days and mastery", () => {
    const db = openDatabase(":memory:");
    const subjectId = uuidv7(4);
    const planId = uuidv7(1);
    const now = Date.UTC(2026, 0, 10, 12);
    db.prepare(`INSERT INTO subjects (id, name, created_at) VALUES (?, 'Fisica', 1)`).run(subjectId);
    db.prepare(
      `INSERT INTO plans (id, title, status, subject_id, exam_at, created_at, updated_at)
       VALUES (?, 'Meccanica', 'ready', ?, ?, 1, 1)`,
    ).run(planId, subjectId, now + 2 * 86_400_000);
    const [row] = listPlans(db, now);
    expect(row?.subject).toBe("Fisica");
    expect(row?.daysToExam).toBe(2);
    expect(row?.mastery).toBe(0);
  });

  it("lists a finished simulation with its score and minutes", () => {
    const db = openDatabase(":memory:");
    const planId = uuidv7(1);
    const started = Date.UTC(2026, 0, 10, 12);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('item', ?, 'simulation', '{}', 1)`,
    ).run(planId);
    db.prepare(
      `INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('run', ?, 'item', ?, ?)`,
    ).run(planId, started, started + 30 * 60_000);
    db.prepare(
      `INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at)
       VALUES ('ans', 'run', ?, ?)`,
    ).run(JSON.stringify({ results: [{ id: "q", score: 1 }, { id: "q2", score: 0 }] }), started);
    expect(listSimulations(db, planId)).toEqual([
      { id: "run", at: started + 30 * 60_000, score: 0.5, minutes: 30 },
    ]);
  });

  it("points the recommended lesson at the open step", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO path_nodes (id, plan_id, kind, position, title, created_at)
       VALUES ('intro', 'p', 'intro', 0, 'Introduzione', 1)`,
    ).run();
    expect(nextLesson(db, "missing")).toBeNull();
    expect(nextLesson(db, "p")).toEqual({ nodeId: "intro", reason: "next", count: 0 });
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

  it("keeps mastery when the only extra row is active time", () => {
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
       VALUES (?, 'lesson_completed', ?, ?, '{}', ?)`,
    ).run(uuidv7(3), planId, topicId, now);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'active_time', ?, NULL, ?, ?)`,
    ).run(uuidv7(4), planId, JSON.stringify({ seconds: 120 }), now);
    const series = planSeries(db, planId, now);
    expect(series.topics[0]?.mastery).toBe(1);
    expect(series.minutes).toBe(2);
  });
});
