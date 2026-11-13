import type Database from "better-sqlite3";
import { recordStep } from "../plans/steps";
import { startOfDay } from "../../shared/local-day";
import { parseSmartText, partQuestions } from "../../shared/smart-text";
import { LIVE_OUTLINE_SQL, type OutlinePart } from "./parts";
import { partTextSql } from "./partText";

// Progress through a topic's lesson in parts: when a part is done, when that finishes the topic's lesson, and what the
// planner, the path and mastery read from the parts. A topic without a live outline gets nothing from here, so it keeps
// counting as one lesson.

export { partQuestions };

/**
 * Marks a part done at `now` unless it already is, inside the caller's transaction. When it is the last part of its
 * topic's live outline (the recap where there is one), the topic's lesson is done: its step is recorded with the first
 * written part's item, which the path reopens. `recordStep` adds no second lesson step, so a part done again, or the
 * parts of a lesson rewritten after its step, add none. Returns whether this part finishes the lesson.
 */
export function finishPart(db: Database.Database, part: { partId: string; outlineId: string; position: number }, now: number): boolean {
  db.prepare("UPDATE lesson_parts SET done_at = ? WHERE id = ? AND done_at IS NULL").run(now, part.partId);
  const outline = db
    .prepare(
      `SELECT o.plan_id AS planId, o.topic_id AS topicId, o.retired_at AS retiredAt,
         (SELECT MAX(position) FROM lesson_parts WHERE outline_id = o.id) AS last,
         (SELECT item_id FROM lesson_parts WHERE outline_id = o.id AND item_id IS NOT NULL ORDER BY position LIMIT 1) AS itemId
       FROM lesson_outlines o WHERE o.id = ?`,
    )
    .get(part.outlineId) as { planId: string; topicId: string; retiredAt: number | null; last: number; itemId: string | null };
  const finished = part.position === outline.last;
  if (finished && outline.retiredAt == null) {
    try {
      recordStep(db, outline.planId, { activity: "lesson", topicId: outline.topicId, itemId: outline.itemId }, now);
    } catch (err) {
      // A lesson on a topic archived since keeps its parts done; there is no path step to add.
      if (!(err instanceof Error) || err.message !== "topic-missing") throw err;
    }
  }
  return finished;
}

/**
 * "Fatto" on a part of the topic's live outline that has no question: one not written yet (the book text shown without
 * an AI tool) or one written without a check. A part with a question is finished by answering it, so this refuses it.
 */
export function markPartDone(
  db: Database.Database,
  input: { planId: string; topicId: string; position: number },
  now = Date.now(),
): { partDone: true; finished: boolean } {
  if (!db.prepare("SELECT 1 FROM topics WHERE id = ? AND plan_id = ?").get(input.topicId, input.planId))
    throw new Error("topic-missing");
  return db.transaction(() => {
    const outline = db.prepare(LIVE_OUTLINE_SQL).get(input.topicId) as { id: string } | undefined;
    const part = outline
      ? (db
          .prepare(
            `SELECT p.id, p.kind, i.body_json AS body FROM lesson_parts p LEFT JOIN items i ON i.id = p.item_id
             WHERE p.outline_id = ? AND p.position = ?`,
          )
          .get(outline.id, input.position) as { id: string; kind: OutlinePart["kind"]; body: string | null } | undefined)
      : undefined;
    if (!outline || !part) throw new Error("part-missing");
    if (part.body != null) {
      const markdown = (JSON.parse(part.body) as { markdown?: string }).markdown ?? "";
      if (partQuestions(parseSmartText(markdown), part.kind).length > 0) throw new Error("part-has-question");
    }
    const finished = finishPart(db, { partId: part.id, outlineId: outline.id, position: input.position }, now);
    return { partDone: true as const, finished };
  })();
}

/** A topic's live outline as the planner and the path count it. */
export type OutlineProgress = {
  /** Parts done, the recap included. */
  done: number;
  /** Minutes of every part, and of the parts not done. */
  minutes: number;
  minutesLeft: number;
};

/** The live outline of each topic of the plan that has one. */
export function outlineProgress(db: Database.Database, planId: string): Map<string, OutlineProgress> {
  const rows = db
    .prepare(
      `SELECT o.topic_id AS topicId, COUNT(p.done_at) AS done,
         COALESCE(SUM(p.minutes), 0) AS minutes,
         COALESCE(SUM(CASE WHEN p.done_at IS NULL THEN p.minutes ELSE 0 END), 0) AS minutesLeft
       FROM lesson_outlines o LEFT JOIN lesson_parts p ON p.outline_id = o.id
       WHERE o.plan_id = ? AND o.retired_at IS NULL
       GROUP BY o.id`,
    )
    .all(planId) as Array<OutlineProgress & { topicId: string }>;
  return new Map(rows.map(({ topicId, ...progress }) => [topicId, progress]));
}

/**
 * The parts of the plan done since `since`, with their minutes, on topics still in the plan. A part of an outline
 * retired since was still studied, so it counts.
 */
export function partsDoneSince(db: Database.Database, planId: string, since: number): Array<{ topicId: string; minutes: number }> {
  return db
    .prepare(
      `SELECT o.topic_id AS topicId, p.minutes FROM lesson_parts p
       JOIN lesson_outlines o ON o.id = p.outline_id
       JOIN topics t ON t.id = o.topic_id AND t.archived_at IS NULL
       WHERE o.plan_id = ? AND p.done_at >= ?
       ORDER BY p.done_at`,
    )
    .all(planId, since) as Array<{ topicId: string; minutes: number }>;
}

/** The part a lesson suggestion names: the first one not done, and where the student left off on an earlier day. */
export type NextPart = {
  position: number;
  /** Teaching parts, the recap left out. */
  count: number;
  kind: OutlinePart["kind"];
  title: string;
  minutes: number;
  written: boolean;
  /** The part done last on this topic, when that was before today; null when it was today or nothing is done. */
  resumeFrom: { position: number; at: number } | null;
};

/** The first part of the topic's live outline not done yet, or null when the topic has no outline or none is left. */
export function nextPart(db: Database.Database, topicId: string, now = Date.now()): NextPart | null {
  const outline = db.prepare(LIVE_OUTLINE_SQL).get(topicId) as { id: string } | undefined;
  if (!outline) return null;
  const parts = db
    .prepare(
      `SELECT position, kind, title, minutes, item_id AS itemId, done_at AS doneAt
       FROM lesson_parts WHERE outline_id = ? ORDER BY position`,
    )
    .all(outline.id) as Array<{
    position: number;
    kind: OutlinePart["kind"];
    title: string;
    minutes: number;
    itemId: string | null;
    doneAt: number | null;
  }>;
  const next = parts.find((part) => part.doneAt == null);
  if (!next) return null;
  const last = parts.reduce<(typeof parts)[number] | null>(
    (latest, part) => (part.doneAt != null && (!latest || part.doneAt > latest.doneAt!) ? part : latest),
    null,
  );
  return {
    position: next.position,
    count: parts.filter((part) => part.kind === "part").length,
    kind: next.kind,
    title: next.title,
    minutes: next.minutes,
    written: next.itemId != null,
    resumeFrom: last && last.doneAt! < startOfDay(now) ? { position: last.position, at: last.doneAt! } : null,
  };
}

/**
 * The outline and position of every lesson item of the plan that is a part's text, in any wording (`partTextSql`), for
 * mastery's lesson unit: the texts of one part share a slot.
 */
export function partSlots(db: Database.Database, planId: string): Map<string, { unit: string; slot: number }> {
  const rows = db
    .prepare(
      `SELECT i.id AS itemId, p.outline_id AS unit, p.position AS slot
       FROM items i JOIN lesson_parts p ON ${partTextSql("p", "i")}
       WHERE i.plan_id = ? AND i.kind = 'lesson'`,
    )
    .all(planId) as Array<{ itemId: string; unit: string; slot: number }>;
  return new Map(rows.map((row) => [row.itemId, { unit: row.unit, slot: row.slot }]));
}
