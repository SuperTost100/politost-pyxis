import type Database from "better-sqlite3";
import { flaggedIds } from "../study/flags";
import { gapMisses } from "../study/gapInsight";
import {
  backfillGapEvents,
  closeGap,
  insertGap,
  linkWrongAnswers,
  readLinks,
  scoresForGap,
} from "../study/gapRows";
import { retrievability, type ScheduleState } from "../study/schedule";
import { uuidv7 } from "../../shared/ids";
import { masteryFor, type MasteryEvent } from "../study/mastery";
import {
  activeMinutes,
  chartPoints,
  replayGaps,
  paceFacts,
  weeklyCounts,
  seriesEvidence,
  type SeriesEvent,
} from "../study/series";

export function planMastery(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  const topics = db
    .prepare(
      `SELECT id, title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position`,
    )
    .all(planId) as Array<{ id: string; title: string }>;
  const events = masteryEvidence(db, planId, now);
  const scores = masteryFor(events, now);
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    mastery: scores[topic.id] ?? 0,
  }));
}

function masteryEvidence(
  db: Database.Database,
  planId: string,
  now: number,
): MasteryEvent[] {
  const events = seriesEvidence(
    readSeries(db, planId).filter((event) => event.at <= now),
  );
  const cards = db
    .prepare(
      `
    SELECT c.id, c.topic_id,
      (SELECT cr.state_json FROM card_reviews cr WHERE cr.card_id=c.id AND cr.reviewed_at<=?
       ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS state_json
    FROM cards c WHERE c.plan_id=? AND c.topic_id IS NOT NULL AND c.created_at<=?
      AND c.suspended=0 AND c.removed=0
  `,
    )
    .all(now, planId, now) as Array<{
    id: string;
    topic_id: string;
    state_json: string | null;
  }>;
  for (const card of cards) {
    // A card never reviewed says nothing about recall yet; counting it as 0 would make new cards lower mastery.
    if (!card.state_json) continue;
    const state = JSON.parse(card.state_json) as ScheduleState;
    events.push({
      topicId: card.topic_id,
      kind: "card",
      cardId: card.id,
      score: retrievability(state, now),
      at: now,
    });
  }
  return events;
}

/** The model proposes the severity; Pyxis forces "severe" when mastery is under half the target. */
export function gapSeverity(
  proposed: "severe" | "minor" | null,
  mastery: number,
  target: number,
): "severe" | "minor" {
  return proposed === "severe" || mastery < target / 2 ? "severe" : "minor";
}

/** A topic without passages contributes zero weight, including untouched topics with passages. */
export function weightedPlanMastery(
  topics: Array<{ id: string; mastery: number }>,
  passageCounts: ReadonlyMap<string, number>,
): number {
  let weighted = 0;
  let count = 0;
  for (const topic of topics) {
    const passages = passageCounts.get(topic.id) ?? 0;
    weighted += topic.mastery * passages;
    count += passages;
  }
  return count ? weighted / count : 0;
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
  const questionKinds = new Map<string, string>();
  const itemBodies = db
    .prepare(
      "SELECT body_json FROM items WHERE plan_id=? AND kind IN ('quiz','diagnostic','review','simulation')",
    )
    .all(planId) as { body_json: string }[];
  for (const item of itemBodies) {
    const body = JSON.parse(item.body_json) as {
      questions?: Array<{ id: string; answer?: { kind: string } }>;
    };
    for (const question of body.questions ?? [])
      if (question.answer?.kind)
        questionKinds.set(question.id, question.answer.kind);
  }
  // Older simulation events have no discriminator; recover it only from the matching saved attempt.
  const legacySimulations = db
    .prepare(
      `
    SELECT aa.created_at, aa.payload_json, i.body_json FROM attempt_answers aa
    JOIN attempts a ON a.id=aa.attempt_id JOIN items i ON i.id=a.item_id
    WHERE a.plan_id=? AND i.kind='simulation' AND a.submitted_at IS NOT NULL
  `,
    )
    .all(planId) as Array<{
    created_at: number;
    payload_json: string;
    body_json: string;
  }>;
  const simulationEvidence = legacySimulations.flatMap((attempt) => {
    const body = JSON.parse(attempt.body_json) as {
      questions?: Array<{ id: string; topicId?: string }>;
    };
    const result = JSON.parse(attempt.payload_json) as {
      results?: Array<{ id: string; score: number }>;
    };
    const topics = new Map<string, number[]>();
    for (const question of body.questions ?? []) {
      const answer = result.results?.find((row) => row.id === question.id);
      if (!question.topicId || !answer) continue;
      const scores = topics.get(question.topicId) ?? [];
      scores.push(answer.score);
      topics.set(question.topicId, scores);
    }
    return [...topics].map(([topicId, scores]) => ({
      topicId,
      scores,
      at: attempt.created_at,
      span: topics.size,
    }));
  });
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
    // A finished quiz, exercise set or card session is a path step on its topic, not a lesson.
    if (row.kind === "lesson_completed" && payload.activity && payload.activity !== "lesson")
      return [];
    const legacySimulation =
      !payload.evidenceKind &&
      !payload.questionScores &&
      simulationEvidence.some(
        (attempt) =>
          attempt.topicId === row.topic_id &&
          row.created_at >= attempt.at &&
          row.created_at < attempt.at + attempt.span &&
          JSON.stringify(attempt.scores) === JSON.stringify(payload.scores),
      );
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
        attemptId: payload.attemptId,
        answers: payload.questionScores?.map(({ id, score }) => ({ id, score })),
        evidenceKind:
          payload.evidenceKind ?? (legacySimulation ? "simulation" : undefined),
        answerKinds: payload.questionScores?.map(
          (answer) =>
            answer.kind ??
            (answer.id ? questionKinds.get(answer.id) : undefined),
        ),
        scores: Array.isArray(payload.scores)
          ? payload.scores.filter((score) => typeof score === "number")
          : undefined,
      },
    ];
  });
}

/**
 * Brings the plan's gap rows in line with its events (PRO-02, PRO-08): opens a gap where an attempt qualifies and none is
 * open on the topic, closes each gap by its own linked answers, and writes one gap_opened and one gap_closed event per
 * gap. Flagged content keeps a gap open on its topic. Safe to repeat; a second call changes nothing.
 */
export function syncGaps(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  db.transaction(() => {
    backfillGapEvents(db, planId);
    const events = readSeries(db, planId);
    const rows = db
      .prepare(
        `SELECT id, topic_id AS topicId, opened_at AS openedAt, closed_at AS closedAt, origin FROM gaps WHERE plan_id = ?`,
      )
      .all(planId) as Array<{
      id: string;
      topicId: string | null;
      openedAt: number;
      closedAt: number | null;
      origin: string;
    }>;
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
  const generatedFlags = db.prepare(`SELECT DISTINCT t.id AS topic_id FROM flags f JOIN exercises e ON e.id=f.target_id AND f.target_kind='exercise' JOIN topics t ON t.id=json_extract(e.locator_json,'$.topicId') WHERE t.plan_id=? AND e.smartbook_id IS NULL
    UNION SELECT DISTINCT i.topic_id AS topic_id FROM flags f JOIN items i ON i.id=f.target_id AND f.target_kind='item' WHERE i.plan_id=? AND i.topic_id IS NOT NULL
    UNION SELECT DISTINCT tp.topic_id FROM flags f JOIN topic_passages tp ON tp.passage_id=f.target_id AND f.target_kind='passage' JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=?`).all(planId,planId,planId) as {topic_id:string}[];
  for (const row of generatedFlags) if (!flagged.some(existing => existing.topic_id === row.topic_id)) flagged.push(row);
    const flaggedTopics = new Set(flagged.map((row) => row.topic_id));
    const links = readLinks(db, planId);
    const tracked = replayGaps(
      events,
      rows
        .filter((row) => row.topicId && row.origin !== "flag")
        .map((row) => ({ id: row.id, topicId: row.topicId!, openedAt: row.openedAt, closedAt: row.closedAt })),
      (gap, event) => scoresForGap(event, gap.id, links),
    );
    for (const gap of tracked) {
      if (gap.id) {
        // A flagged topic keeps its open gap however well the answers go.
        if (gap.closedAt != null && !rows.find((row) => row.id === gap.id)?.closedAt && !flaggedTopics.has(gap.topicId))
          closeGap(db, gap.id, Math.min(gap.closedAt, now), "answers");
        continue;
      }
      const flagRow = rows.find(
        (row) => row.topicId === gap.topicId && row.origin === "flag" && row.closedAt == null,
      );
      if (flagRow && gap.closedAt == null) {
        // The flag-only gap becomes the answers gap: one open gap for the topic, as before.
        db.prepare("UPDATE gaps SET origin = 'answers', opened_at = MIN(opened_at, ?) WHERE id = ?").run(
          gap.openedAt,
          flagRow.id,
        );
        flagRow.origin = "answers";
        continue;
      }
      const id = insertGap(db, { planId, topicId: gap.topicId, openedAt: gap.openedAt, origin: "answers" });
      if (gap.closedAt != null) closeGap(db, id, Math.min(gap.closedAt, now), "answers");
    }
    const open = db
      .prepare("SELECT id, topic_id AS topicId, origin FROM gaps WHERE plan_id = ? AND closed_at IS NULL")
      .all(planId) as Array<{ id: string; topicId: string | null; origin: string }>;
    for (const row of open)
      if (row.origin === "flag" && row.topicId && !flaggedTopics.has(row.topicId))
        closeGap(db, row.id, now, "flag");
    for (const topicId of flaggedTopics) {
      if (open.some((row) => row.topicId === topicId)) continue;
      insertGap(db, { planId, topicId, openedAt: now, origin: "flag" });
    }
    linkWrongAnswers(db, planId, events);
  })();
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
  const passageCounts = new Map(
    (
      db
        .prepare(
          `
    SELECT t.id, count(tp.passage_id) AS count FROM topics t
    LEFT JOIN topic_passages tp ON tp.topic_id=t.id WHERE t.plan_id=? GROUP BY t.id
  `,
        )
        .all(planId) as Array<{ id: string; count: number }>
    ).map((row) => [row.id, row.count]),
  );
  const preparation = weightedPlanMastery(topics, passageCounts);
  const historicalAverage = (at: number) => {
    const scores = masteryFor(masteryEvidence(db, planId, at), at);
    return weightedPlanMastery(
      topics.map((topic) => ({ id: topic.id, mastery: scores[topic.id] ?? 0 })),
      passageCounts,
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
      `SELECT topic_id,created_at FROM learning_events WHERE plan_id=? AND kind='lesson_completed' AND topic_id IS NOT NULL
       AND coalesce(json_extract(payload_json, '$.activity'), 'lesson') = 'lesson'`,
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
        .filter((event) => event.kind === "quiz" && event.evidenceKind !== "check")
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
      `SELECT g.id AS gapId, g.topic_id AS topicId, g.opened_at AS openedAt, g.misconception, g.severity, g.comparison,
         (SELECT count(*) FROM gap_answers ga WHERE ga.gap_id = g.id) AS linked
       FROM gaps g
       WHERE g.plan_id = ? AND g.closed_at IS NULL AND g.topic_id IN (SELECT id FROM topics WHERE archived_at IS NULL)`,
    )
    .all(planId) as Array<{
    gapId: string;
    topicId: string;
    openedAt: number;
    misconception: string | null;
    severity: "severe" | "minor" | null;
    comparison: "unchecked" | null;
    linked: number;
  }>;
  const rankedGaps = gaps
    .map(({ linked, comparison, ...gap }) => ({
      ...gap,
      // True while this misconception could not be compared with the topic's other gaps, so it may repeat one of them.
      unmerged: comparison === "unchecked",
      misses: gapMisses(db, gap.gapId, 2).map(
        ({ passageIds: _passageIds, answer: _answer, ...miss }) => miss,
      ),
      severity: gapSeverity(
        gap.severity,
        topics.find((topic) => topic.id === gap.topicId)?.mastery ?? 0,
        target,
      ),
      // PRO-02: the number of wrong answers linked to this gap. Gaps written before links existed count the topic's misses since they opened.
      wrongAnswers:
        linked ||
        studied
          .filter(
            (event) =>
              event.kind === "quiz" &&
              event.evidenceKind !== "check" &&
              event.topicId === gap.topicId &&
              event.at >= gap.openedAt,
          )
          .reduce(
            (sum, event) =>
              sum +
              (event.scores ?? [event.score]).filter((score) => score < 1)
                .length,
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

type ScorePayload = {
  attemptId?: string;
  /** Set on lesson_completed steps; older ones are lessons or plan-wide nodes. */
  activity?: string;
  score?: number;
  scores?: number[];
  seconds?: number;
  evidenceKind?: "quiz" | "simulation" | "check";
  questionScores?: Array<{
    id?: string;
    sourceIds?: string[];
    kind?: string;
    score: number;
  }>;
};

function scorePayload(raw: string, blocked: Set<string>): ScorePayload | null {
  const payload = JSON.parse(raw) as ScorePayload;
  if (!payload.questionScores) return payload;
  const rows = payload.questionScores.filter(
    (row) =>
      (!row.id || !blocked.has(row.id)) &&
      !(row.sourceIds ?? []).some((id) => blocked.has(id)),
  );
  if (!rows.length) return null;
  return {
    ...payload,
    questionScores: rows,
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
  const generated = db
    .prepare(
      "SELECT id,prompt,json_extract(locator_json,'$.topicId') AS topicId FROM exercises WHERE smartbook_id IS NULL AND json_extract(locator_json,'$.topicId') IN (SELECT id FROM topics WHERE plan_id = ?)",
    )
    .all(planId) as { id: string; prompt: string; topicId: string }[];
  for (const exercise of generated)
    labels.set(key("exercise", exercise.id), {
      label: exercise.prompt.slice(0, 200),
      topicId: exercise.topicId,
    });
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
