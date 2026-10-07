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

type StepPayload = { activity?: string; nodeId?: string; result?: StepResult };

/**
 * The plan's finished activities in the order they happened. Each is a lesson_completed event; older plans stored
 * only the path node they finished, so the node's kind and topic stand in for the activity. Work on a topic that
 * is gone or archived is left out.
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
 * introduction already done stays one step. Returns whether a step was added.
 */
export function recordStep(
  db: Database.Database,
  planId: string,
  step: { activity: Activity; topicId?: string | null; result?: StepResult | null },
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
  appendEvent(db, {
    kind: "lesson_completed",
    planId,
    topicId,
    payload: {
      activity: step.activity,
      ...(node ? { nodeId: node.id } : {}),
      ...(step.result ? { result: step.result } : {}),
    },
    at: now,
  });
  return true;
}
