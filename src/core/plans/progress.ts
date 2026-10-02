import type Database from "better-sqlite3";
import { flaggedIds } from "../study/flags";
import { uuidv7 } from "../../shared/ids";
import { masteryFor, type MasteryEvent } from "../study/mastery";
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
  const plan = db.prepare("SELECT target FROM plans WHERE id=?").get(planId) as
    { target: number } | undefined;
  const target = plan?.target ?? 0.8;
  const ids = topics.map((topic) => topic.id);
  const average = (rows: ReturnType<typeof planMastery>) =>
    rows.reduce((sum, row) => sum + row.mastery, 0) / Math.max(1, rows.length);
  const preparation = average(topics);
  const historicalAverage = (at: number) => {
    const scores = masteryFor(
      studied
        .filter((event) => event.at <= at)
        .map((event) => ({
          topicId: event.topicId,
          kind: event.kind,
          score: event.score,
          at: event.at,
        })),
      at,
    );
    return (
      ids.reduce((sum, id) => sum + (scores[id] ?? 0), 0) /
      Math.max(1, ids.length)
    );
  };
  const chart = chartPoints(events, now).map((point) => {
    const end = new Date(point.day);
    end.setDate(end.getDate() + 1);
    end.setHours(0, 0, 0, 0);
    return {
      ...point,
      mastery: historicalAverage(Math.min(now, end.getTime() - 1)),
    };
  });
  const completed = db
    .prepare(
      "SELECT topic_id,created_at FROM learning_events WHERE plan_id=? AND kind='lesson_completed' AND topic_id IS NOT NULL",
    )
    .all(planId) as { topic_id: string | null; created_at: number }[];
  const topicDates = new Map(
    (
      db
        .prepare("SELECT id,created_at FROM topics WHERE plan_id=?")
        .all(planId) as { id: string; created_at: number }[]
    ).map((row) => [row.id, row.created_at]),
  );
  const skillTopics = topics.map((topic) => {
    const rows = events.filter(
      (event) => event.topicId === topic.id && event.at <= now,
    );
    const lastStudied = rows.length
      ? rows.reduce((latest, event) => Math.max(latest, event.at), 0)
      : null;
    return {
      ...topic,
      exercisesSolved: rows
        .filter((event) => event.kind === "quiz")
        .reduce(
          (sum, event) =>
            sum +
            (event.scores ?? [event.score]).filter((score) => score >= 1)
              .length,
          0,
        ),
      lessons: completed.filter(
        (row) => row.topic_id === topic.id && row.created_at <= now,
      ).length,
      lastStudied,
      idle:
        now - (lastStudied ?? topicDates.get(topic.id) ?? now) >=
          21 * 86400000 && topic.mastery < target,
    };
  });
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
  const rankedGaps = gaps
    .map((gap) => ({
      ...gap,
      severity:
        (topics.find((topic) => topic.id === gap.topicId)?.mastery ?? 0) <
        target / 2
          ? ("severe" as const)
          : ("minor" as const),
      wrongAnswers: studied
        .filter(
          (event) =>
            event.kind === "quiz" &&
            event.topicId === gap.topicId &&
            event.at >= gap.openedAt,
        )
        .reduce(
          (sum, event) =>
            sum +
            (event.scores ?? [event.score]).filter((score) => score < 1).length,
          0,
        ),
    }))
    .sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "severe" ? -1 : 1) ||
        b.wrongAnswers - a.wrongAnswers ||
        a.openedAt - b.openedAt,
    );
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const weekdaySeconds = Array<number>(7).fill(0);
  for (const bar of activity.bars)
    weekdaySeconds[new Date(bar.day).getDay()]! += bar.seconds;
  const peak = Math.max(...weekdaySeconds);
  return {
    chart,
    preparation: {
      mastery: preparation,
      target,
      weeklyChange:
        preparation -
        historicalAverage(
          (() => {
            const at = new Date(now);
            at.setDate(at.getDate() - 7);
            return at.getTime();
          })(),
        ),
      onTrack: topics.filter((topic) => topic.mastery >= target).length,
      totalTopics: topics.length,
      lessons: completed.filter((row) => row.created_at <= now).length,
    },
    weeks: weeks.weeks,
    counts: weeks.counts,
    gaps: rankedGaps,
    flagged: flaggedContent(db, planId),
    pace: {
      ...paceFacts(chart, now, activity.bars),
      bars: activity.bars,
      weekMinutes: Math.round(activity.weekSeconds / 60),
      weekLessons: completed.filter(
        (row) => row.created_at >= start.getTime() && row.created_at <= now,
      ).length,
      mostActiveWeekday: peak > 0 ? weekdaySeconds.indexOf(peak) : null,
    },
    minutes: Math.round(activity.weekSeconds / 60),
    lessons: completed.filter((row) => row.created_at <= now).length,
    topics: skillTopics,
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

function flaggedContent(db: Database.Database, planId: string) {
  const items = db
    .prepare("SELECT id,topic_id,body_json FROM items WHERE plan_id=?")
    .all(planId) as {
    id: string;
    topic_id: string | null;
    body_json: string;
  }[];
  const labels = new Map<string, { label: string; topicId?: string }>();
  const key = (kind: string, id: string) => JSON.stringify([kind, id]);
  const passages = db
    .prepare(
      "SELECT p.id,p.section_path,p.text,t.id AS topicId FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id JOIN passages p ON p.id=tp.passage_id WHERE t.plan_id=? ORDER BY t.position,p.created_at,p.id",
    )
    .all(planId) as {
    id: string;
    section_path: string | null;
    text: string;
    topicId: string;
  }[];
  for (const passage of passages)
    if (!labels.has(key("passage", passage.id)))
      labels.set(key("passage", passage.id), {
        label: (passage.section_path?.trim() || passage.text).slice(0, 200),
        topicId: passage.topicId,
      });
  for (const item of items) {
    const body = JSON.parse(item.body_json) as {
      markdown?: string;
      questions?: {
        id: string;
        sourceId?: string;
        sourceIds?: string[];
        stem: string;
        topicId?: string;
      }[];
    };
    labels.set(key("item", item.id), {
      label: (body.markdown ?? item.id).slice(0, 200),
      topicId: item.topic_id ?? undefined,
    });
    for (const q of body.questions ?? [])
      for (const id of [q.id, q.sourceId].filter((id): id is string =>
        Boolean(id),
      ))
        labels.set(key("exercise", id), {
          label: q.stem.slice(0, 200),
          topicId: q.topicId ?? item.topic_id ?? undefined,
        });
  }
  const exercises = db
    .prepare(
      "SELECT e.id,e.prompt FROM exercises e JOIN smartbooks sb ON sb.id=e.smartbook_id JOIN plan_sources ps ON ps.source_id=sb.source_id WHERE ps.plan_id=?",
    )
    .all(planId) as { id: string; prompt: string }[];
  for (const e of exercises)
    if (!labels.has(key("exercise", e.id)))
      labels.set(key("exercise", e.id), { label: e.prompt.slice(0, 200) });
  const flags = db
    .prepare(
      "SELECT id,target_kind AS targetKind,target_id AS targetId,reason,created_at AS createdAt FROM flags ORDER BY created_at DESC,id",
    )
    .all() as {
    id: string;
    targetKind: string;
    targetId: string;
    reason: string | null;
    createdAt: number;
  }[];
  return flags.flatMap((flag) => {
    const content = labels.get(key(flag.targetKind, flag.targetId));
    return content ? [{ ...flag, reason: flag.reason ?? "", ...content }] : [];
  });
}
