import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { attemptOutcome } from "./outcome";

const SUBMITTED = 1_800_000_000_000;

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Analisi', 'ready', 1, 1)",
  ).run();
  for (const [id, title, position] of [
    ["limits", "Limiti", 0],
    ["series", "Serie", 1],
    ["untouched", "Integrali", 2],
  ] as const)
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'plan', ?, ?, 1)",
    ).run(id, title, position);
  db.prepare(
    "INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('quiz', 'plan', 'limits', 'quiz', '{\"questions\":[]}', 1)",
  ).run();
  const answer = db.prepare(
    "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES (?, 'answer_given', 'plan', ?, ?, ?)",
  );
  // Earlier study on both topics, then this attempt's answers on Limiti and Serie.
  answer.run("e1", "limits", JSON.stringify({ score: 1, scores: [1] }), SUBMITTED - 60_000);
  answer.run("e2", "series", JSON.stringify({ score: 0.2, scores: [0.2] }), SUBMITTED - 60_000);
  answer.run("e3", "limits", JSON.stringify({ attemptId: "a1", score: 0, scores: [0] }), SUBMITTED);
  // A simulation writes its topics a millisecond apart.
  answer.run("e4", "series", JSON.stringify({ attemptId: "a1", score: 1, scores: [1] }), SUBMITTED + 1);
  // Study after the attempt must not change what the attempt did.
  answer.run("e5", "limits", JSON.stringify({ score: 1, scores: [1] }), SUBMITTED + 60_000);
  db.prepare(
    "INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('a1', 'plan', 'quiz', ?, ?)",
  ).run(SUBMITTED - 300_000, SUBMITTED);
  return db;
}

describe("attemptOutcome", () => {
  it("compares each topic's mastery just before and at the hand-in, leaving out topics it did not move", () => {
    const db = fixture();
    const { topics } = attemptOutcome(db, "a1");
    expect(topics.map((topic) => topic.id)).toEqual(["limits", "series"]);
    const limits = topics.find((topic) => topic.id === "limits")!;
    const series = topics.find((topic) => topic.id === "series")!;
    expect(limits.title).toBe("Limiti");
    expect(limits.after).toBeLessThan(limits.before);
    expect(series.after).toBeGreaterThan(series.before);
    // One earlier answer of 1 over the prior of 3, then a 0 added: 1/4 down to 1/5.
    expect(limits.before).toBeCloseTo(1 / 4, 3);
    expect(limits.after).toBeCloseTo(1 / 5, 3);
  });

  it("lists the gaps the attempt's answers count for, and the engine that answered when the chosen one refused", () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO gaps (id, plan_id, topic_id, opened_at, origin, misconception, severity) VALUES ('g1', 'plan', 'limits', ?, 'answers', 'Tratta 0·∞ come 0.', 'severe')",
    ).run(SUBMITTED);
    db.prepare(
      "INSERT INTO gap_answers (gap_id, attempt_id, question_id) VALUES ('g1', 'a1', 'q1'), ('g1', 'a1', 'q2')",
    ).run();
    const job = db.prepare(
      "INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at, fallback_json) VALUES (?, ?, ?, 'succeeded', 1, ?, ?, ?)",
    );
    job.run("other", "quiz-grade", JSON.stringify({ attemptId: "elsewhere" }), 1, 1, JSON.stringify({ from: "A", to: "B", reason: "limit" }));
    job.run("check", "quiz-check", JSON.stringify({ attemptId: "a1" }), 2, 2, JSON.stringify({ from: "Claude Code", to: "Codex", reason: "limit" }));
    job.run("grade", "quiz-grade", JSON.stringify({ attemptId: "a1" }), 3, 3, null);
    const outcome = attemptOutcome(db, "a1");
    expect(outcome.gaps).toEqual([
      { id: "g1", topicId: "limits", severity: "severe", misconception: "Tratta 0·∞ come 0.", open: true },
    ]);
    expect(outcome.fallback).toEqual({ from: "Claude Code", to: "Codex", reason: "limit" });
  });

  it("changes nothing for an attempt not handed in yet", () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES ('open', 'plan', 'quiz', ?)",
    ).run(SUBMITTED);
    expect(attemptOutcome(db, "open")).toEqual({ topics: [], gaps: [] });
    expect(() => attemptOutcome(db, "missing")).toThrow("attempt-missing");
  });
});
