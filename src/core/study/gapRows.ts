import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { appendEvent } from "../events";
import type { SeriesEvent } from "./series";

export type GapOrigin = "answers" | "flag" | "misconception";

/**
 * Every write to `gaps` goes through here, so each gap writes one `gap_opened` and one `gap_closed` event, in the
 * same transaction as the row. A gap's id is its durable identity: closing, drills, reviews, ranking and links use it.
 */
export function insertGap(
  db: Database.Database,
  gap: {
    planId: string;
    topicId: string;
    openedAt: number;
    origin: GapOrigin;
    misconception?: string;
    severity?: "severe" | "minor";
    comparison?: "unchecked";
  },
): string {
  const id = uuidv7(gap.openedAt);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO gaps (id, plan_id, topic_id, opened_at, origin, misconception, severity, comparison)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      gap.planId,
      gap.topicId,
      gap.openedAt,
      gap.origin,
      gap.misconception ?? null,
      gap.severity ?? null,
      gap.comparison ?? null,
    );
    appendEvent(db, {
      kind: "gap_opened",
      planId: gap.planId,
      topicId: gap.topicId,
      payload: { gapId: id, origin: gap.origin },
      at: gap.openedAt,
    });
  })();
  return id;
}

/** Closes an open gap once. Returns false when it was already closed, so nothing is written twice. */
export function closeGap(
  db: Database.Database,
  gapId: string,
  at: number,
  reason: "answers" | "flag" | "merged",
  mergedInto?: string,
): boolean {
  return db.transaction(() => {
    const gap = db
      .prepare("SELECT plan_id AS planId, topic_id AS topicId, opened_at AS openedAt FROM gaps WHERE id = ? AND closed_at IS NULL")
      .get(gapId) as { planId: string; topicId: string | null; openedAt: number } | undefined;
    if (!gap) return false;
    const closedAt = Math.max(at, gap.openedAt);
    db.prepare("UPDATE gaps SET closed_at = ?, merged_into = ? WHERE id = ?").run(closedAt, mergedInto ?? null, gapId);
    appendEvent(db, {
      kind: "gap_closed",
      planId: gap.planId,
      topicId: gap.topicId,
      payload: { gapId, reason, ...(mergedInto ? { into: mergedInto } : {}) },
      at: closedAt,
    });
    return true;
  })();
}

/** Gaps written before events existed get their missing opened/closed event once. */
export function backfillGapEvents(db: Database.Database, planId: string) {
  const written = new Set(
    (
      db
        .prepare(
          `SELECT kind || ':' || json_extract(payload_json, '$.gapId') FROM learning_events
           WHERE plan_id = ? AND kind IN ('gap_opened', 'gap_closed')`,
        )
        .pluck()
        .all(planId) as string[]
    ),
  );
  const rows = db
    .prepare("SELECT id, topic_id, opened_at, closed_at, origin, merged_into FROM gaps WHERE plan_id = ?")
    .all(planId) as Array<{
    id: string;
    topic_id: string | null;
    opened_at: number;
    closed_at: number | null;
    origin: string;
    merged_into: string | null;
  }>;
  for (const row of rows) {
    if (!written.has(`gap_opened:${row.id}`))
      appendEvent(db, {
        kind: "gap_opened",
        planId,
        topicId: row.topic_id,
        payload: { gapId: row.id, origin: row.origin },
        at: row.opened_at,
      });
    if (row.closed_at != null && !written.has(`gap_closed:${row.id}`))
      appendEvent(db, {
        kind: "gap_closed",
        planId,
        topicId: row.topic_id,
        payload: row.merged_into
          ? { gapId: row.id, reason: "merged", into: row.merged_into }
          : { gapId: row.id, reason: "answers" },
        at: row.closed_at,
      });
  }
}

/** Which gaps each wrong answer (attempt + question) counts for. A key with no entry is not linked yet. */
export function readLinks(db: Database.Database, planId: string): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  const rows = db
    .prepare(
      `SELECT ga.gap_id, ga.attempt_id, ga.question_id FROM gap_answers ga
       JOIN gaps g ON g.id = ga.gap_id WHERE g.plan_id = ?`,
    )
    .all(planId) as Array<{ gap_id: string; attempt_id: string; question_id: string }>;
  for (const row of rows) {
    const key = linkKey(row.attempt_id, row.question_id);
    links.set(key, (links.get(key) ?? new Set()).add(row.gap_id));
  }
  return links;
}

export const linkKey = (attemptId: string, questionId: string) => `${attemptId}\u0000${questionId}`;

/** The answers of one event that count for a gap: a wrong answer linked only to other gaps is left out. */
export function scoresForGap(
  event: SeriesEvent,
  gapId: string | undefined,
  links: Map<string, Set<string>>,
): number[] {
  if (!gapId || !event.attemptId || !event.answers) return event.scores ?? [event.score];
  const attemptId = event.attemptId;
  return event.answers
    .filter((answer) => {
      if (answer.score >= 1 || !answer.id) return true;
      const linked = links.get(linkKey(attemptId, answer.id));
      return !linked || linked.has(gapId);
    })
    .map((answer) => answer.score);
}

type Explicit = { exists: boolean; gapId?: string; questions: Map<string, string> };

/** A drill's own questions belong to the gap it was built for: by its `gap_items` row, or the `gapId` a review stored on an adopted question. */
function explicitGaps(db: Database.Database, attemptId: string): Explicit {
  const row = db
    .prepare(
      `SELECT i.body_json, (SELECT gap_id FROM gap_items WHERE item_id = a.item_id LIMIT 1) AS gap_id
       FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
    )
    .get(attemptId) as { body_json: string; gap_id: string | null } | undefined;
  const questions = new Map<string, string>();
  try {
    for (const question of (JSON.parse(row?.body_json ?? "{}") as { questions?: Array<{ id: string; gapId?: string }> }).questions ?? [])
      if (question.gapId) questions.set(question.id, question.gapId);
  } catch {
    // An unreadable body just has no explicit links.
  }
  return { exists: row != null, gapId: row?.gap_id ?? undefined, questions };
}

/**
 * Links each wrong answer in the events to the open gaps it counts for, once. A drill question counts for its own gap;
 * any other wrong answer counts for every open gap on its topic until an analysis assigns it to one (`assignAnswers`).
 * A flag-only gap has no answers.
 */
export function linkWrongAnswers(db: Database.Database, planId: string, events: SeriesEvent[]) {
  const open = db
    .prepare(
      "SELECT id, topic_id AS topicId, opened_at AS openedAt FROM gaps WHERE plan_id = ? AND closed_at IS NULL AND origin != 'flag' AND topic_id IS NOT NULL",
    )
    .all(planId) as Array<{ id: string; topicId: string; openedAt: number }>;
  if (open.length === 0) return;
  const links = readLinks(db, planId);
  const insert = db.prepare("INSERT OR IGNORE INTO gap_answers (gap_id, attempt_id, question_id) VALUES (?, ?, ?)");
  const explicit = new Map<string, Explicit>();
  for (const event of events) {
    if (event.kind !== "quiz" || !event.attemptId || !event.answers) continue;
    const mine = open.filter((gap) => gap.topicId === event.topicId && gap.openedAt <= event.at);
    if (mine.length === 0) continue;
    for (const answer of event.answers) {
      if (!answer.id || answer.score >= 1 || links.has(linkKey(event.attemptId, answer.id))) continue;
      if (!explicit.has(event.attemptId)) explicit.set(event.attemptId, explicitGaps(db, event.attemptId));
      const own = explicit.get(event.attemptId)!;
      // An event can outlive its attempt; with no attempt there is nothing to link.
      if (!own.exists) continue;
      const target = own.questions.get(answer.id) ?? own.gapId;
      const targets = mine.some((gap) => gap.id === target) ? [target!] : mine.map((gap) => gap.id);
      for (const gapId of targets) insert.run(gapId, event.attemptId, answer.id);
    }
  }
}

/** Gives wrong answers to one gap alone: an analysis decided they belong to that misconception. */
export function assignAnswers(db: Database.Database, gapId: string, attemptId: string, questionIds: string[]) {
  const remove = db.prepare("DELETE FROM gap_answers WHERE attempt_id = ? AND question_id = ? AND gap_id != ?");
  const add = db.prepare("INSERT OR IGNORE INTO gap_answers (gap_id, attempt_id, question_id) VALUES (?, ?, ?)");
  for (const questionId of questionIds) {
    remove.run(attemptId, questionId, gapId);
    add.run(gapId, attemptId, questionId);
  }
}

/** One gap absorbs another: its answers and drill items move, a severe reading stays severe, and the absorbed gap closes as merged. */
export function mergeGap(db: Database.Database, fromId: string, intoId: string, now = Date.now()) {
  db.transaction(() => {
    db.prepare("UPDATE OR IGNORE gap_answers SET gap_id = ? WHERE gap_id = ?").run(intoId, fromId);
    db.prepare("DELETE FROM gap_answers WHERE gap_id = ?").run(fromId);
    db.prepare("UPDATE OR IGNORE gap_items SET gap_id = ? WHERE gap_id = ?").run(intoId, fromId);
    db.prepare(
      `UPDATE gaps SET severity = 'severe'
       WHERE id = ? AND closed_at IS NULL AND (SELECT severity FROM gaps WHERE id = ?) = 'severe'`,
    ).run(intoId, fromId);
    closeGap(db, fromId, now, "merged", intoId);
  })();
}
