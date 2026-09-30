import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { idleTopics, masteryFor, type MasteryEvent } from "../study/mastery";
import { chartPoints, openGaps, paceFacts, weeklyCounts, type SeriesEvent } from "../study/series";

export function planMastery(db: Database.Database, planId: string, now = Date.now()) {
  const topics = db
    .prepare(`SELECT id, title FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string; title: string }>;
  const rows = db
    .prepare(
      `SELECT topic_id, kind, payload_json, created_at FROM learning_events
       WHERE plan_id = ? AND topic_id IS NOT NULL`,
    )
    .all(planId) as Array<{
    topic_id: string;
    kind: string;
    payload_json: string;
    created_at: number;
  }>;
  const events: MasteryEvent[] = rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { score?: number };
    return {
      topicId: row.topic_id,
      kind: row.kind === "card_rated" ? "card" : row.kind === "answer_given" ? "quiz" : "lesson",
      score:
        typeof payload.score === "number"
          ? payload.score
          : row.kind === "lesson_completed"
            ? 1
            : 0.5,
      at: row.created_at,
    };
  });
  const scores = masteryFor(events, now);
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    mastery: scores[topic.id] ?? 0,
  }));
}

function readSeries(db: Database.Database, planId: string): SeriesEvent[] {
  const rows = db
    .prepare(
      `SELECT topic_id, kind, payload_json, created_at FROM learning_events
       WHERE plan_id = ? AND topic_id IS NOT NULL`,
    )
    .all(planId) as Array<{
    topic_id: string;
    kind: string;
    payload_json: string;
    created_at: number;
  }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { score?: number; scores?: number[] };
    const kind = row.kind === "card_rated" ? "card" : row.kind === "answer_given" ? "quiz" : "lesson";
    return {
      topicId: row.topic_id,
      at: row.created_at,
      kind,
      score:
        typeof payload.score === "number" ? payload.score : row.kind === "lesson_completed" ? 1 : 0.5,
      scores: Array.isArray(payload.scores)
        ? payload.scores.filter((score) => typeof score === "number")
        : undefined,
    };
  });
}

export function syncGaps(db: Database.Database, planId: string, now = Date.now()) {
  const open = openGaps(readSeries(db, planId));
  const existing = db
    .prepare(`SELECT id, topic_id, closed_at FROM gaps WHERE plan_id = ?`)
    .all(planId) as Array<{ id: string; topic_id: string | null; closed_at: number | null }>;
  const still = new Set(open.map((gap) => gap.topicId));
  for (const row of existing) {
    if (row.closed_at == null && row.topic_id && !still.has(row.topic_id)) {
      db.prepare(`UPDATE gaps SET closed_at = ? WHERE id = ?`).run(now, row.id);
    }
  }
  for (const gap of open) {
    const live = existing.find((row) => row.topic_id === gap.topicId && row.closed_at == null);
    if (live) continue;
    db.prepare(
      `INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES (?, ?, ?, ?)`,
    ).run(uuidv7(gap.openedAt), planId, gap.topicId, gap.openedAt);
  }
}

export function planSeries(db: Database.Database, planId: string, now = Date.now()) {
  syncGaps(db, planId, now);
  const topics = planMastery(db, planId, now);
  const events = readSeries(db, planId);
  const idle = new Set(
    idleTopics(
      events.map((event) => ({
        topicId: event.topicId,
        kind: event.kind,
        score: event.score,
        at: event.at,
      })),
      now,
    ),
  );
  const chart = chartPoints(events, now);
  const weeks = weeklyCounts(
    events,
    topics.map((topic) => topic.id),
    now,
  );
  const gaps = db
    .prepare(
      `SELECT topic_id AS topicId, opened_at AS openedAt FROM gaps
       WHERE plan_id = ? AND closed_at IS NULL AND topic_id IS NOT NULL`,
    )
    .all(planId) as Array<{ topicId: string; openedAt: number }>;
  return {
    chart,
    weeks: weeks.weeks,
    counts: weeks.counts,
    gaps,
    pace: paceFacts(chart, now),
    lessons: events.filter((event) => event.kind === "lesson").length,
    topics: topics.map((topic) => ({ ...topic, idle: idle.has(topic.id) })),
  };
}
