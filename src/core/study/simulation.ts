import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { syncGaps } from "../plans/progress";
import { submitAttempt } from "./attempt";
import { topicExercises } from "./exercises";

type Stored = {
  minutes: number;
  questions: Array<{
    id: string;
    topicId?: string;
    stem: string;
    answer: { kind: "completion"; accepted: string[][] };
  }>;
};

function topicScores(db: Database.Database, stored: Stored, attemptId: string, submitted: boolean) {
  if (!submitted) return [];
  const answer = db
    .prepare(
      `SELECT payload_json FROM attempt_answers WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(attemptId) as { payload_json: string } | undefined;
  if (!answer) return [];
  const payload = JSON.parse(answer.payload_json) as {
    results?: Array<{ id: string; score: number }>;
  };
  const scores = new Map((payload.results ?? []).map((row) => [row.id, row.score]));
  const byTopic = new Map<string, number[]>();
  for (const question of stored.questions) {
    if (!question.topicId) continue;
    const list = byTopic.get(question.topicId) ?? [];
    list.push(scores.get(question.id) ?? 0);
    byTopic.set(question.topicId, list);
  }
  return [...byTopic].map(([id, list]) => {
    const title = db.prepare(`SELECT title FROM topics WHERE id = ?`).get(id) as
      | { title: string }
      | undefined;
    return {
      id,
      title: title?.title ?? id,
      score: list.reduce((sum, score) => sum + score, 0) / list.length,
    };
  });
}

export function startSimulation(
  db: Database.Database,
  planId: string,
  minutes = 30,
  now = Date.now(),
) {
  const topics = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string }>;
  const questions = topics
    .flatMap((topic) =>
      topicExercises(db, topic.id)
        .filter((row) => row.answer && row.answer.trim())
        .map((row) => ({
          id: row.id,
          topicId: topic.id,
          stem: row.prompt,
          answer: { kind: "completion" as const, accepted: [[row.answer ?? ""]] },
        })),
    )
    .slice(0, 20);
  if (questions.length === 0) throw new Error("simulation-empty");
  const body: Stored = { minutes, questions };
  const itemId = uuidv7(now);
  const attemptId = uuidv7(now + 1);
  db.prepare(
    `INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at)
     VALUES (?, ?, 'simulation', ?, 'sources', ?)`,
  ).run(itemId, planId, JSON.stringify(body), now);
  db.prepare(
    `INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES (?, ?, ?, ?)`,
  ).run(attemptId, planId, itemId, now);
  return {
    attemptId,
    deadline: now + minutes * 60_000,
    questions: questions.map((question) => ({ id: question.id, stem: question.stem })),
  };
}

export function readSimulation(db: Database.Database, attemptId: string, now = Date.now()) {
  const row = db
    .prepare(
      `SELECT a.started_at, a.submitted_at, a.plan_id, i.body_json
       FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
    )
    .get(attemptId) as
    | { started_at: number; submitted_at: number | null; plan_id: string; body_json: string }
    | undefined;
  if (!row) throw new Error("attempt-missing");
  const stored = JSON.parse(row.body_json) as Stored;
  const deadline = row.started_at + stored.minutes * 60_000;
  if (row.submitted_at == null && now >= deadline) {
    const scored = submitAttempt(db, attemptId, {}, now);
    recordTopicScores(db, row.plan_id, stored.questions, scored.results, now);
    syncGaps(db, row.plan_id, now);
  }
  const submitted = db
    .prepare(`SELECT submitted_at FROM attempts WHERE id = ?`)
    .get(attemptId) as { submitted_at: number | null };
  return {
    attemptId,
    planId: row.plan_id,
    deadline,
    leftMs: submitted.submitted_at == null ? Math.max(0, deadline - now) : 0,
    submitted: submitted.submitted_at != null,
    questions: stored.questions.map((question) => ({ id: question.id, stem: question.stem })),
    topics: topicScores(db, stored, attemptId, submitted.submitted_at != null),
  };
}

export function recordTopicScores(
  db: Database.Database,
  planId: string,
  questions: Array<{ topicId?: string }>,
  results: Array<{ score: number }>,
  now: number,
): void {
  const byTopic = new Map<string, number[]>();
  questions.forEach((question, index) => {
    const topicId = question.topicId;
    const score = results[index]?.score;
    if (!topicId || score == null) return;
    const list = byTopic.get(topicId) ?? [];
    list.push(score);
    byTopic.set(topicId, list);
  });
  let at = now;
  for (const [topicId, scores] of byTopic) {
    const score = scores.reduce((sum, item) => sum + item, 0) / scores.length;
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    ).run(uuidv7(at), planId, topicId, JSON.stringify({ score, scores }), at);
    at += 1;
  }
}

export function openSimulation(db: Database.Database, planId: string, now = Date.now()) {
  const row = db
    .prepare(
      `SELECT a.id FROM attempts a
       JOIN items i ON i.id = a.item_id
       WHERE a.plan_id = ? AND i.kind = 'simulation' AND a.submitted_at IS NULL
       ORDER BY a.started_at DESC LIMIT 1`,
    )
    .get(planId) as { id: string } | undefined;
  if (!row) return null;
  return readSimulation(db, row.id, now);
}
