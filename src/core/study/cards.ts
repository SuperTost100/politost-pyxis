import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { masteredAfterDays, newCard, review, type Rating, type ScheduleState } from "./schedule";

export type DueCard = {
  id: string;
  front: string;
  back: string;
  topicId: string | null;
  sectionPath: string | null;
  passageId: string | null;
  sourceId: string | null;
  chapter: number | null;
  state: ScheduleState;
};

export function seedCards(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    pairs: Array<{ front: string; back: string; passageId?: string | null }>;
  },
): string[] {
  const exists = db.prepare(
    `SELECT id, passage_id, back FROM cards
     WHERE plan_id = ? AND topic_id = ? AND (seed_key = ? OR (seed_key IS NULL AND TRIM(front) = ?))
     LIMIT 1`,
  );
  const link = db.prepare(
    `UPDATE cards SET passage_id = ? WHERE id = ? AND passage_id IS NULL`,
  );
  const insert = db.prepare(
    `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, passage_id, seed_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'sources', ?, ?, ?)`,
  );
  const ids: string[] = [];
  for (const pair of input.pairs) {
    const front = pair.front.trim();
    const back = pair.back.trim();
    const prior = exists.get(input.planId, input.topicId, front, front) as
      | { id: string; passage_id: string | null; back: string }
      | undefined;
    if (prior) {
      if (prior.passage_id == null && pair.passageId && prior.back.trim() === back) {
        link.run(pair.passageId, prior.id);
      }
      continue;
    }
    const now = Date.now();
    const id = uuidv7(now);
    insert.run(id, input.planId, input.topicId, front, back, pair.passageId ?? null, front, now);
    ids.push(id);
  }
  return ids;
}

export function dueCards(
  db: Database.Database,
  planId: string,
  now: number,
  topicId?: string,
): DueCard[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.front, c.back, c.topic_id,
        c.passage_id,
        (SELECT p.section_path FROM passages p WHERE p.id = c.passage_id) AS section_path,
        (SELECT p.source_id FROM passages p WHERE p.id = c.passage_id) AS source_id,
        (SELECT json_extract(p.locator_json, '$.chapter') FROM passages p WHERE p.id = c.passage_id) AS chapter,
        (SELECT cr.state_json FROM card_reviews cr
         WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC LIMIT 1) AS state_json,
        COALESCE(
          CAST(json_extract(
            (SELECT cr.state_json FROM card_reviews cr
             WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC LIMIT 1),
            '$.dueAt'
          ) AS INTEGER),
          ?
        ) AS due_at
       FROM cards c
       WHERE c.plan_id = ?
         AND c.suspended = 0
         AND c.removed = 0
         AND (? IS NULL OR c.topic_id = ?)
         AND COALESCE(
           CAST(json_extract(
             (SELECT cr.state_json FROM card_reviews cr
              WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC LIMIT 1),
             '$.dueAt'
           ) AS INTEGER),
           ?
         ) <= ?
       ORDER BY due_at ASC
       LIMIT 20`,
    )
    .all(now, planId, topicId ?? null, topicId ?? null, now, now) as Array<{
    id: string;
    front: string;
    back: string;
    topic_id: string | null;
    passage_id: string | null;
    section_path: string | null;
    source_id: string | null;
    chapter: number | null;
    state_json: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    front: row.front,
    back: row.back,
    topicId: row.topic_id,
    sectionPath: row.section_path,
    passageId: row.passage_id,
    sourceId: row.source_id,
    chapter: row.chapter,
    state: row.state_json ? (JSON.parse(row.state_json) as ScheduleState) : newCard(now),
  }));
}

export function rateCard(
  db: Database.Database,
  cardId: string,
  rating: Rating,
  now: number,
): ScheduleState {
  const latest = db
    .prepare(
      `SELECT state_json FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at DESC LIMIT 1`,
    )
    .get(cardId) as { state_json: string } | undefined;

  const state: ScheduleState = latest
    ? (JSON.parse(latest.state_json) as ScheduleState)
    : newCard(now);
  const next = review(state, rating, now);

  db.prepare(
    `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(uuidv7(now), cardId, rating, JSON.stringify(next), now);
  const card = db
    .prepare(`SELECT plan_id, topic_id FROM cards WHERE id = ?`)
    .get(cardId) as { plan_id: string; topic_id: string | null } | undefined;
  if (card) {
    const score = rating === "again" ? 0 : rating === "hard" ? 0.5 : 1;
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'card_rated', ?, ?, ?, ?)`,
    ).run(uuidv7(now + 1), card.plan_id, card.topic_id, JSON.stringify({ score }), now);
  }

  return next;
}

export function queueCounts(
  db: Database.Database,
  planId: string,
  topicId: string,
): { fresh: number; learning: number; mastered: number } {
  const rows = db
    .prepare(
      `SELECT
        (SELECT cr.state_json FROM card_reviews cr
         WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC LIMIT 1) AS state_json
       FROM cards c
       WHERE c.plan_id = ? AND c.topic_id = ? AND c.suspended = 0 AND c.removed = 0`,
    )
    .all(planId, topicId) as Array<{ state_json: string | null }>;
  let fresh = 0;
  let learning = 0;
  let mastered = 0;
  for (const row of rows) {
    if (!row.state_json) {
      fresh += 1;
      continue;
    }
    const state = JSON.parse(row.state_json) as ScheduleState;
    if (state.intervalDays >= masteredAfterDays) mastered += 1;
    else learning += 1;
  }
  return { fresh, learning, mastered };
}

export function saveCard(
  db: Database.Database,
  input: { planId: string; topicId: string; cardId?: string; front: string; back: string },
  now = Date.now(),
): { id: string } {
  const front = input.front.trim();
  const back = input.back.trim();
  if (!front || !back) throw new Error("card-blank");
  if (input.cardId) {
    const result = db
      .prepare(`UPDATE cards SET front = ?, back = ? WHERE id = ? AND plan_id = ?`)
      .run(front, back, input.cardId, input.planId);
    if (result.changes === 0) throw new Error("card-missing");
    return { id: input.cardId };
  }
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO cards (id, plan_id, topic_id, front, back, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.planId, input.topicId, front, back, now);
  return { id };
}

export function deleteCard(db: Database.Database, cardId: string): void {
  const row = db.prepare(`SELECT seed_key FROM cards WHERE id = ?`).get(cardId) as
    | { seed_key: string | null }
    | undefined;
  if (!row) throw new Error("card-missing");
  if (row.seed_key) {
    db.prepare(`UPDATE cards SET removed = 1 WHERE id = ?`).run(cardId);
    return;
  }
  db.prepare(`DELETE FROM cards WHERE id = ?`).run(cardId);
}

export function suspendedCards(
  db: Database.Database,
  planId: string,
  topicId: string,
): Array<{ id: string; front: string }> {
  return db
    .prepare(
      `SELECT id, front FROM cards
       WHERE plan_id = ? AND topic_id = ? AND suspended = 1 AND removed = 0
       ORDER BY created_at`,
    )
    .all(planId, topicId) as Array<{ id: string; front: string }>;
}

export function setSuspended(db: Database.Database, cardId: string, suspended: boolean): void {
  const result = db.prepare(`UPDATE cards SET suspended = ? WHERE id = ?`).run(suspended ? 1 : 0, cardId);
  if (result.changes === 0) throw new Error("card-missing");
}
