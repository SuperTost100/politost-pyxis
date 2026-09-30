import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { newCard, review, type Rating, type ScheduleState } from "./schedule";

export type DueCard = {
  id: string;
  front: string;
  back: string;
  topicId: string | null;
  state: ScheduleState;
};

export function seedCards(
  db: Database.Database,
  input: { planId: string; topicId: string; pairs: Array<{ front: string; back: string }> },
): string[] {
  const exists = db.prepare(
    `SELECT 1 FROM cards WHERE plan_id = ? AND TRIM(front) = ? LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at)
     VALUES (?, ?, ?, ?, ?, 'sources', ?)`,
  );
  const ids: string[] = [];
  for (const pair of input.pairs) {
    const front = pair.front.trim();
    const back = pair.back.trim();
    if (exists.get(input.planId, front)) continue;
    const now = Date.now();
    const id = uuidv7(now);
    insert.run(id, input.planId, input.topicId, front, back, now);
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
    state_json: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    front: row.front,
    back: row.back,
    topicId: row.topic_id,
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

  return next;
}
