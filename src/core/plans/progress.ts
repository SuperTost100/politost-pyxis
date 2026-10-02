import type Database from "better-sqlite3";
import { flaggedIds } from "../study/flags";
import { uuidv7 } from "../../shared/ids";
import { idleTopics, masteryFor, type MasteryEvent } from "../study/mastery";
import {
  activeMinutes,
  chartPoints,
  openGaps,
  paceFacts,
  weeklyCounts,
  type SeriesEvent,
} from "../study/series";

export function planMastery(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
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
  const blocked = flaggedIds(db, "exercise");
  const events: MasteryEvent[] = rows.flatMap((row) => {
    if (
      row.kind === "active_time" ||
      row.kind === "gap_opened" ||
      row.kind === "gap_closed"
    ) {
      return [];
    }
    const payload = scorePayload(row.payload_json, blocked);
    if (!payload) return [];
    return [
      {
        topicId: row.topic_id,
        kind:
          row.kind === "card_rated"
            ? "card"
            : row.kind === "answer_given"
              ? "quiz"
              : "lesson",
        score:
          typeof payload.score === "number"
            ? payload.score
            : row.kind === "lesson_completed"
              ? 1
              : 0.5,
        at: row.created_at,
      },
    ];
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
       WHERE plan_id = ?`,
    )
    .all(planId) as Array<{
    topic_id: string | null;
    kind: string;
    payload_json: string;
    created_at: number;
  }>;
  const blocked = flaggedIds(db, "exercise");
  return rows.flatMap((row): SeriesEvent[] => {
    if (row.kind === "gap_opened" || row.kind === "gap_closed") return [];
    const payload = scorePayload(row.payload_json, blocked);
    if (!payload) return [];
    if (row.kind === "active_time") {
      return [
        {
          topicId: row.topic_id ?? "",
          at: row.created_at,
          kind: "active" as const,
          score: 0,
          seconds: typeof payload.seconds === "number" ? payload.seconds : 0,
        },
      ];
    }
    if (!row.topic_id) return [];
    const kind =
      row.kind === "card_rated"
        ? "card"
        : row.kind === "answer_given"
          ? "quiz"
          : "lesson";
    return [
      {
        topicId: row.topic_id,
        at: row.created_at,
        kind,
        score:
          typeof payload.score === "number"
            ? payload.score
            : row.kind === "lesson_completed"
              ? 1
              : 0.5,
        scores: Array.isArray(payload.scores)
          ? payload.scores.filter((score) => typeof score === "number")
          : undefined,
      },
    ];
  });
}

export function syncGaps(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  const open = openGaps(readSeries(db, planId));
  const existing = db
    .prepare(`SELECT id, topic_id, closed_at FROM gaps WHERE plan_id = ?`)
    .all(planId) as Array<{
    id: string;
    topic_id: string | null;
    closed_at: number | null;
  }>;
  const still = new Set(open.map((gap) => gap.topicId));
  const flagged = db
    .prepare(
      `SELECT DISTINCT t.id AS topic_id
       FROM flags f
       JOIN exercises e ON e.id = f.target_id AND f.target_kind = 'exercise'
       JOIN smartbooks sb ON sb.id = e.smartbook_id
       JOIN plan_sources ps ON ps.source_id = sb.source_id AND ps.plan_id = ?
       JOIN topics t ON t.plan_id = ps.plan_id
       JOIN topic_passages tp ON tp.topic_id = t.id
       JOIN passages p ON p.id = tp.passage_id
       WHERE json_extract(p.locator_json, '$.chapter') = json_extract(e.locator_json, '$.chapter')
         AND p.source_id = sb.source_id`,
    )
    .all(planId) as Array<{ topic_id: string }>;
  for (const row of flagged) still.add(row.topic_id);
  for (const row of existing) {
    if (row.closed_at == null && row.topic_id && !still.has(row.topic_id)) {
      db.prepare(`UPDATE gaps SET closed_at = ? WHERE id = ?`).run(now, row.id);
    }
  }
  for (const gap of open) {
    const live = existing.find(
      (row) => row.topic_id === gap.topicId && row.closed_at == null,
    );
    if (live) continue;
    db.prepare(
      `INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES (?, ?, ?, ?)`,
    ).run(uuidv7(gap.openedAt), planId, gap.topicId, gap.openedAt);
  }
  for (const row of flagged) {
    if (open.some((gap) => gap.topicId === row.topic_id)) continue;
    const live = existing.find(
      (item) => item.topic_id === row.topic_id && item.closed_at == null,
    );
    if (live) continue;
    db.prepare(
      `INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES (?, ?, ?, ?)`,
    ).run(uuidv7(now), planId, row.topic_id, now);
  }
}

export function planSeries(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  syncGaps(db, planId, now);
  const topics = planMastery(db, planId, now);
  const events = readSeries(db, planId);
  const studied = events.filter(
    (event): event is SeriesEvent & { kind: "quiz" | "card" | "lesson" } =>
      event.kind !== "active",
  );
  const idle = new Set(
    idleTopics(
      studied.map((event) => ({
        topicId: event.topicId,
        kind: event.kind,
        score: event.score,
        at: event.at,
      })),
      now,
    ),
  );
  const chart = chartPoints(events, now);
  const activity = activeMinutes(events, now);
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
    pace: paceFacts(chart, now, activity.bars),
    minutes: Math.round(activity.weekSeconds / 60),
    lessons: studied.filter((event) => event.kind === "lesson").length,
    topics: topics.map((topic) => ({ ...topic, idle: idle.has(topic.id) })),
  };
}

function scorePayload(
  raw: string,
  blocked: Set<string>,
): { score?: number; scores?: number[]; seconds?: number } | null {
  const payload = JSON.parse(raw) as {
    score?: number;
    scores?: number[];
    seconds?: number;
    questionScores?: Array<{ id: string; sourceIds: string[]; score: number }>;
  };
  if (!payload.questionScores) return payload;
  const rows = payload.questionScores.filter(
    (row) =>
      !blocked.has(row.id) && !row.sourceIds.some((id) => blocked.has(id)),
  );
  if (!rows.length) return null;
  return {
    ...payload,
    scores: rows.map((row) => row.score),
    score: rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
  };
}
