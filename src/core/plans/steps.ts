import type Database from "better-sqlite3";
import { appendEvent } from "../events";
import {
  activities,
  activityOf,
  stageOf,
  topicActivities,
  type Activity,
  type Step,
  type StepResult,
} from "./path";

type StepPayload = {
  activity?: string;
  nodeId?: string;
  result?: StepResult;
  itemId?: unknown;
  attemptId?: unknown;
};

/** The item kind a step's attempt belongs to, and whether that quiz is a gap drill. */
const attemptKinds: Partial<Record<Activity, { kind: string; drill: 0 | 1 }>> = {
  quiz: { kind: "quiz", drill: 0 },
  gaps: { kind: "quiz", drill: 1 },
  diagnostic: { kind: "diagnostic", drill: 0 },
  simulation: { kind: "simulation", drill: 0 },
};

/**
 * The plan's finished activities in the order they happened. Each is a lesson_completed event; older plans stored
 * only the path node they finished, so the node's kind and topic stand in for the activity. Work on a topic that
 * is gone or archived is left out. A quiz, drill, diagnostic or simulation step recorded before steps named their
 * attempt gets the latest attempt of that kind and topic submitted by the step's time, so it can still be reopened.
 */
export function readSteps(db: Database.Database, planId: string): Step[] {
  const nodes = new Map(
    (
      db
        .prepare("SELECT id, kind, topic_id FROM path_nodes WHERE plan_id = ?")
        .all(planId) as Array<{ id: string; kind: string; topic_id: string | null }>
    ).map((node) => [node.id, node]),
  );
  const live = new Set(
    (
      db
        .prepare("SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL")
        .all(planId) as Array<{ id: string }>
    ).map((topic) => topic.id),
  );
  const earlierAttempt = db.prepare(
    `SELECT a.id FROM attempts a JOIN items i ON i.id = a.item_id
     WHERE a.plan_id = ? AND a.submitted_at IS NOT NULL AND a.submitted_at <= ? AND i.kind = ?
       AND (? IS NULL OR i.topic_id = ?)
       AND EXISTS (SELECT 1 FROM gap_items g WHERE g.item_id = i.id) = ?
     ORDER BY a.submitted_at DESC, a.rowid DESC LIMIT 1`,
  );
  const rows = db
    .prepare(
      `SELECT id, topic_id, payload_json, created_at FROM learning_events
       WHERE plan_id = ? AND kind = 'lesson_completed' ORDER BY created_at, rowid`,
    )
    .all(planId) as Array<{
    id: string;
    topic_id: string | null;
    payload_json: string;
    created_at: number;
  }>;
  return rows.flatMap((row): Step[] => {
    let payload: StepPayload;
    try {
      payload = JSON.parse(row.payload_json) as StepPayload;
    } catch {
      return [];
    }
    const node = payload.nodeId ? nodes.get(payload.nodeId) : undefined;
    const activity =
      payload.activity && (activities as readonly string[]).includes(payload.activity)
        ? (payload.activity as Activity)
        : node
          ? activityOf(node.kind)
          : null;
    if (!activity) return [];
    const topicId = row.topic_id ?? node?.topic_id ?? null;
    if (topicActivities.has(activity) && (!topicId || !live.has(topicId))) return [];
    const itemId =
      (activity === "lesson" || activity === "intro") && typeof payload.itemId === "string"
        ? payload.itemId
        : null;
    const kind = attemptKinds[activity];
    const attemptId = !kind
      ? null
      : typeof payload.attemptId === "string"
        ? payload.attemptId
        : ((
            earlierAttempt.get(
              planId,
              row.created_at,
              kind.kind,
              topicActivities.has(activity) ? topicId : null,
              topicActivities.has(activity) ? topicId : null,
              kind.drill,
            ) as { id: string } | undefined
          )?.id ?? null);
    const result =
      payload.result &&
      Number.isFinite(payload.result.correct) &&
      Number.isFinite(payload.result.total)
        ? { correct: payload.result.correct, total: payload.result.total }
        : null;
    return [
      {
        id: row.id,
        activity,
        topicId: topicActivities.has(activity) ? topicId : null,
        at: row.created_at,
        result,
        itemId,
        attemptId,
      },
    ];
  });
}

/** The score of a submitted attempt as right answers out of all; partial credit rounds to the nearest answer. */
export function stepResult(results: Array<{ score: number }>): StepResult {
  return {
    correct: Math.round(results.reduce((sum, result) => sum + result.score, 0)),
    total: results.length,
  };
}

/**
 * Records a finished activity as a step on the path, for any topic. Reading is recorded once: a lesson or the
 * introduction already done stays one step. A step names what was done so the path can reopen it: the submitted
 * attempt of a quiz, drill, diagnostic or simulation, and the lesson or introduction read (the newest one when the
 * caller does not say). Returns whether a step was added.
 */
export function recordStep(
  db: Database.Database,
  planId: string,
  step: {
    activity: Activity;
    topicId?: string | null;
    result?: StepResult | null;
    itemId?: string | null;
    attemptId?: string | null;
  },
  now = Date.now(),
): boolean {
  const topicId = topicActivities.has(step.activity) ? (step.topicId ?? null) : null;
  if (topicActivities.has(step.activity)) {
    const topic = db
      .prepare("SELECT 1 FROM topics WHERE id = ? AND plan_id = ? AND archived_at IS NULL")
      .get(topicId, planId);
    if (!topic) throw new Error("topic-missing");
  } else if (!db.prepare("SELECT 1 FROM plans WHERE id = ?").get(planId)) {
    throw new Error("plan-missing");
  }
  if (
    (step.activity === "lesson" || step.activity === "intro") &&
    readSteps(db, planId).some(
      (done) => done.activity === step.activity && done.topicId === topicId,
    )
  )
    return false;
  const stage = stageOf(step.activity);
  // Older readers know a step by its path node, so the node is kept when the plan has one.
  const node = stage
    ? (db
        .prepare(
          `SELECT id FROM path_nodes WHERE plan_id = ? AND kind = ?
           AND ((? IS NULL AND topic_id IS NULL) OR topic_id = ?) ORDER BY position LIMIT 1`,
        )
        .get(planId, stage, topicId, topicId) as { id: string } | undefined)
    : undefined;
  const itemId =
    step.activity === "lesson" || step.activity === "intro"
      ? (step.itemId ??
        (
          db
            .prepare(
              `SELECT id FROM items WHERE plan_id = ? AND kind = ? AND (? IS NULL OR topic_id = ?)
               ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            )
            .get(planId, step.activity, topicId, topicId) as { id: string } | undefined
        )?.id)
      : undefined;
  const attemptId = attemptKinds[step.activity] ? step.attemptId : undefined;
  appendEvent(db, {
    kind: "lesson_completed",
    planId,
    topicId,
    payload: {
      activity: step.activity,
      ...(node ? { nodeId: node.id } : {}),
      ...(step.result ? { result: step.result } : {}),
      ...(itemId ? { itemId } : {}),
      ...(attemptId ? { attemptId } : {}),
    },
    at: now,
  });
  return true;
}

/**
 * The lessons the student finished, with their topic and time. Progress, the topic list and the path all count lessons
 * here, so one finished lesson is one everywhere: a step recorded only by its path node counts, and one on an archived
 * topic does not.
 */
export function finishedLessons(db: Database.Database, planId: string): Array<{ topicId: string; at: number }> {
  return readSteps(db, planId).flatMap((step) =>
    step.activity === "lesson" && step.topicId ? [{ topicId: step.topicId, at: step.at }] : [],
  );
}

/**
 * How many graded activities the student did on a topic after `since` (the time its lesson was recorded as read).
 * Each submitted attempt with answers on the topic is one (a quiz, a gap drill, and the topic's share of a diagnostic,
 * review or simulation); so is each run of self-ratings of exercises, each run of card ratings and each run of quick
 * check answers in one lesson. A run ends at a different kind of evidence or at any step on the topic, so two practice
 * sessions each finished with "Mark as done" are two. Reading, opening and unrated exercises are not graded.
 */
export function gradedActivities(
  db: Database.Database,
  planId: string,
  topicId: string,
  since: number,
): number {
  const rows = db
    .prepare(
      `SELECT id, kind, item_id, payload_json FROM learning_events
       WHERE plan_id = ? AND topic_id = ? AND created_at > ?
         AND kind IN ('answer_given', 'card_rated', 'lesson_completed')
       ORDER BY created_at, rowid`,
    )
    .all(planId, topicId, since) as Array<{
    id: string;
    kind: string;
    item_id: string | null;
    payload_json: string;
  }>;
  let count = 0;
  let run: string | null = null;
  for (const row of rows) {
    if (row.kind === "lesson_completed") {
      run = null;
      continue;
    }
    let payload: { evidenceKind?: unknown; attemptId?: unknown };
    try {
      payload = JSON.parse(row.payload_json) as typeof payload;
    } catch {
      continue;
    }
    const key =
      row.kind === "card_rated"
        ? "cards"
        : payload.evidenceKind === "self"
          ? "practice"
          : payload.evidenceKind === "check"
            ? `check:${row.item_id ?? ""}`
            : typeof payload.attemptId === "string"
              ? `attempt:${payload.attemptId}`
              : `event:${row.id}`;
    if (key !== run) count += 1;
    run = key;
  }
  return count;
}
