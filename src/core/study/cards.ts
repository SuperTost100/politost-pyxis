import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { startOfDay } from "../../shared/local-day";
import { putSetting } from "../settings";
import {
  isMastered,
  newCard,
  review,
  type Rating,
  type ScheduleState,
} from "./schedule";

export type DueCard = {
  id: string;
  front: string;
  back: string;
  topicId: string | null;
  sectionPath: string | null;
  passageId: string | null;
  sourceId: string | null;
  chapter: number | null;
  /** Written by the student: deleting it is permanent, so the review asks first. */
  handMade: boolean;
  state: ScheduleState;
};

/**
 * Which review of a card is its latest: the newest `reviewed_at`, and of two at the same time the one stored last
 * (highest rowid). undoRating removes that same review. The `card_reviews_card` index serves this order.
 */
const LATEST_REVIEW_ORDER = "ORDER BY cr.reviewed_at DESC, cr.rowid DESC";

/** A subquery reading `column` of the latest review of the card in `card` (an alias with `id`, or a `?` for the ID). */
export function latestReview(column: "state_json" | "rating" | "reviewed_at" | "id", card = "c.id"): string {
  return `(SELECT cr.${column} FROM card_reviews cr WHERE cr.card_id = ${card} ${LATEST_REVIEW_ORDER} LIMIT 1)`;
}

/** Cards that can come up for review: not suspended, not removed, not in an archived topic. */
const ACTIVE = `c.suspended = 0
         AND c.removed = 0
         AND (c.topic_id IS NULL OR c.topic_id NOT IN (SELECT id FROM topics WHERE archived_at IS NOT NULL))`;

/**
 * The cards reviewed together. An exam's cards are its deck. Cards with no exam form one deck per subject, and those
 * that lost their subject too form one more (`subjectId: null`). Each deck has its own daily limit of new cards.
 */
export type CardDeck = { planId: string } | { subjectId: string | null };

/** The topic filter for an exam's cards that have no topic, where the due queries take a topic. No topic id is empty. */
export const NO_TOPIC = "";

/** The deck's cards, as SQL on `c` with its parameters. An archived exam's deck is empty. */
function deckWhere(deck: CardDeck): { sql: string; params: unknown[] } {
  return "planId" in deck
    ? {
        sql: `c.plan_id = ?
         AND NOT EXISTS (SELECT 1 FROM plans ap WHERE ap.id = c.plan_id AND ap.archived_at IS NOT NULL)`,
        params: [deck.planId],
      }
    : { sql: "c.plan_id IS NULL AND c.subject_id IS ?", params: [deck.subjectId] };
}

/**
 * Active, due cards of a deck; after the deck's own parameters: topicId twice, ids JSON twice, now twice, the new
 * cards allowed today (JSON, or null for no cap) twice.
 */
const dueFrom = (where: string) => `FROM cards c
       WHERE ${where}
         AND ${ACTIVE}
         AND (? IS NULL OR COALESCE(c.topic_id, '') = ?)
         AND (? IS NULL OR c.id IN (SELECT value FROM json_each(?)))
         AND COALESCE(
           CAST(json_extract(${latestReview("state_json")}, '$.dueAt') AS INTEGER),
           ?
         ) <= ?
         AND (? IS NULL
           OR EXISTS (SELECT 1 FROM card_reviews r WHERE r.card_id = c.id)
           OR c.id IN (SELECT value FROM json_each(?)))`;

const NEW_PER_DAY = "cards.newPerDay";
const defaultNewPerDay = 20;
const maxNewPerDay = 999;

/** How many never-reviewed cards each deck (an exam, or a subject's cards with no exam) introduces per day. */
export function newCardsPerDay(db: Database.Database): number {
  const row = db
    .prepare(`SELECT value_json FROM settings WHERE key = ?`)
    .get(NEW_PER_DAY) as { value_json: string } | undefined;
  const value = row ? (JSON.parse(row.value_json) as unknown) : undefined;
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maxNewPerDay, Math.max(0, value))
    : defaultNewPerDay;
}

export function setNewCardsPerDay(
  db: Database.Database,
  count: number,
  now = Date.now(),
): number {
  const value = Math.min(maxNewPerDay, Math.max(0, Math.round(count)));
  putSetting(db, NEW_PER_DAY, value, now);
  return value;
}

/** The new cards this deck can still introduce today: the daily limit minus the cards first rated since local midnight. */
export function newCardsLeftToday(
  db: Database.Database,
  deck: CardDeck,
  now: number,
): { limit: number; left: number } {
  const limit = newCardsPerDay(db);
  const where = deckWhere(deck);
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cards c
       WHERE ${where.sql}
         AND (SELECT MIN(cr.reviewed_at) FROM card_reviews cr WHERE cr.card_id = c.id) >= ?`,
    )
    .get(...where.params, startOfDay(now)) as { n: number };
  return { limit, left: Math.max(0, limit - n) };
}

/**
 * The never-reviewed cards that may come up today, oldest first, up to what is left of the deck's daily limit. With a
 * topic, the topic's own new cards fill that allowance, so a topic built after another still gets its cards.
 */
function newCardsAllowed(
  db: Database.Database,
  deck: CardDeck,
  now: number,
  topicId: string | null,
): string[] {
  const { left } = newCardsLeftToday(db, deck, now);
  if (left === 0) return [];
  const where = deckWhere(deck);
  return (
    db
      .prepare(
        `SELECT c.id FROM cards c
         WHERE ${where.sql}
           AND ${ACTIVE}
           AND (? IS NULL OR COALESCE(c.topic_id, '') = ?)
           AND NOT EXISTS (SELECT 1 FROM card_reviews r WHERE r.card_id = c.id)
         ORDER BY c.created_at, c.rowid
         LIMIT ?`,
      )
      .all(...where.params, topicId, topicId, left) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** How many cards of a deck are due, without the session limit of dueCards. New cards count up to the daily limit. */
export function countDeckDue(
  db: Database.Database,
  deck: CardDeck,
  now: number,
  topicId?: string,
): number {
  const allowed = JSON.stringify(newCardsAllowed(db, deck, now, topicId ?? null));
  const where = deckWhere(deck);
  return (
    db
      .prepare(`SELECT COUNT(*) AS n ${dueFrom(where.sql)}`)
      .get(...where.params, topicId ?? null, topicId ?? null, null, null, now, now, allowed, allowed) as {
      n: number;
    }
  ).n;
}

/** How many cards of an exam are due. */
export function countDueCards(
  db: Database.Database,
  planId: string,
  now: number,
  topicId?: string,
): number {
  return countDeckDue(db, { planId }, now, topicId);
}

/**
 * The decks of cards with no exam that hold any card that could come up, in subject order, the cards without a subject
 * last. Archived topics cannot hold such cards, since a card with a topic has an exam.
 */
export function examlessDecks(
  db: Database.Database,
): Array<{ subjectId: string | null; subject: string | null }> {
  return db
    .prepare(
      `SELECT DISTINCT c.subject_id AS subjectId, s.name AS subject, s.position
       FROM cards c LEFT JOIN subjects s ON s.id = c.subject_id
       WHERE c.plan_id IS NULL AND c.suspended = 0 AND c.removed = 0
       ORDER BY s.id IS NULL, s.position, s.name COLLATE NOCASE, s.id`,
    )
    .all()
    .map((row) => {
      const { subjectId, subject } = row as { subjectId: string | null; subject: string | null };
      return { subjectId, subject };
    });
}

export function dueCards(
  db: Database.Database,
  planId: string,
  now: number,
  topicId?: string,
  /**
   * Only these cards (a stored review queue); they still have to be due and active; cards of an archived topic are never
   * due. The queue was picked within the daily limit of new cards, so it is not limited again.
   */
  ids?: string[],
): DueCard[] {
  return deckDueCards(db, { planId }, now, topicId, ids);
}

/** Up to 20 due cards of a deck, the most overdue first. */
export function deckDueCards(
  db: Database.Database,
  deck: CardDeck,
  now: number,
  topicId?: string,
  ids?: string[],
): DueCard[] {
  const allowed = ids
    ? null
    : JSON.stringify(newCardsAllowed(db, deck, now, topicId ?? null));
  const where = deckWhere(deck);
  const rows = db
    .prepare(
      `SELECT c.id, c.front, c.back, c.topic_id,
        c.passage_id, c.seed_key,
        (SELECT p.section_path FROM passages p WHERE p.id = c.passage_id) AS section_path,
        (SELECT p.source_id FROM passages p WHERE p.id = c.passage_id) AS source_id,
        (SELECT json_extract(p.locator_json, '$.chapter') FROM passages p WHERE p.id = c.passage_id) AS chapter,
        ${latestReview("state_json")} AS state_json,
        COALESCE(
          CAST(json_extract(${latestReview("state_json")}, '$.dueAt') AS INTEGER),
          ?
        ) AS due_at
       ${dueFrom(where.sql)}
       ORDER BY due_at ASC, c.created_at, c.rowid
       LIMIT 20`,
    )
    .all(
      now,
      ...where.params,
      topicId ?? null,
      topicId ?? null,
      ids ? JSON.stringify(ids) : null,
      ids ? JSON.stringify(ids) : null,
      now,
      now,
      allowed,
      allowed,
    ) as Array<{
    id: string;
    front: string;
    back: string;
    topic_id: string | null;
    passage_id: string | null;
    seed_key: string | null;
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
    handMade: row.seed_key == null,
    state: row.state_json
      ? (JSON.parse(row.state_json) as ScheduleState)
      : newCard(now),
  }));
}

export function rateCard(
  db: Database.Database,
  cardId: string,
  rating: Rating,
  now: number,
): ScheduleState & { reviewId: string } {
  return db.transaction(() => {
    const card = db
      .prepare(
        `SELECT c.plan_id, c.topic_id, c.suspended, c.removed, p.exam_at
         FROM cards c LEFT JOIN plans p ON p.id = c.plan_id WHERE c.id = ?`,
      )
      .get(cardId) as
      | {
          plan_id: string | null;
          topic_id: string | null;
          suspended: number;
          removed: number;
          exam_at: number | null;
        }
      | undefined;
    if (!card || card.removed) throw new Error("card-missing");
    if (card.suspended) throw new Error("card-suspended");
    const latest = db
      .prepare(
        `SELECT cr.state_json FROM card_reviews cr WHERE cr.card_id = ? ${LATEST_REVIEW_ORDER} LIMIT 1`,
      )
      .get(cardId) as { state_json: string } | undefined;

    const state: ScheduleState = latest
      ? (JSON.parse(latest.state_json) as ScheduleState)
      : newCard(now);
    if (state.dueAt > now) throw new Error("card-not-due");
    const next = review(state, rating, now, card.exam_at);

    const reviewId = uuidv7(now);
    db.prepare(
      `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at)
     VALUES (?, ?, ?, ?, ?)`,
    ).run(reviewId, cardId, rating, JSON.stringify(next), now);
    // The event is evidence for an exam's mastery and path; a card with no exam has none to feed.
    if (card.plan_id == null) return { ...next, reviewId };
    const score = rating === "again" ? 0 : rating === "hard" ? 0.5 : 1;
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
     VALUES (?, 'card_rated', ?, ?, ?, ?)`,
    ).run(
      uuidv7(now + 1),
      card.plan_id,
      card.topic_id,
      JSON.stringify({ score, cardId }),
      now,
    );

    return { ...next, reviewId };
  })();
}

/**
 * Takes back a rating: deletes the review and the `card_rated` event written with it, so the card returns to the
 * schedule state it had before (the previous review, or new) and is due again. Only the card's latest review can go.
 */
export function undoRating(
  db: Database.Database,
  reviewId: string,
): { cardId: string } {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT r.card_id, r.reviewed_at, c.plan_id FROM card_reviews r
         JOIN cards c ON c.id = r.card_id WHERE r.id = ?`,
      )
      .get(reviewId) as
      | { card_id: string; reviewed_at: number; plan_id: string | null }
      | undefined;
    if (!row) throw new Error("review-missing");
    const latest = db
      .prepare(
        `SELECT ${latestReview("id", "?")} AS id`,
      )
      .get(row.card_id) as { id: string };
    if (latest.id !== reviewId) throw new Error("review-not-latest");
    db.prepare(`DELETE FROM card_reviews WHERE id = ?`).run(reviewId);
    if (row.plan_id == null) return { cardId: row.card_id };
    // rateCard writes the event in the same transaction with the review's time; one rating per card per millisecond.
    db.prepare(
      `DELETE FROM learning_events
       WHERE id = (SELECT id FROM learning_events
         WHERE plan_id = ? AND created_at = ? AND kind = 'card_rated'
           AND json_extract(payload_json, '$.cardId') = ?
         LIMIT 1)`,
    ).run(row.plan_id, row.reviewed_at, row.card_id);
    return { cardId: row.card_id };
  })();
}

export function queueCounts(
  db: Database.Database,
  planId: string,
  topicId: string,
): { fresh: number; learning: number; mastered: number } {
  const rows = db
    .prepare(
      `SELECT
        ${latestReview("state_json")} AS state_json
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
    if (isMastered(state)) mastered += 1;
    else learning += 1;
  }
  return { fresh, learning, mastered };
}

/**
 * Edits a card (by `cardId`; a plan, when given, has to be the card's) or writes a new one, under an exam's topic or,
 * with no exam, under a subject.
 */
export function saveCard(
  db: Database.Database,
  input: {
    planId?: string;
    topicId?: string;
    subjectId?: string;
    cardId?: string;
    front: string;
    back: string;
  },
  now = Date.now(),
): { id: string } {
  const front = input.front.trim();
  const back = input.back.trim();
  if (!front || !back) throw new Error("card-blank");
  if (input.cardId) {
    const result = db
      .prepare(
        `UPDATE cards SET front = ?, back = ? WHERE id = ? AND (? IS NULL OR plan_id = ?)`,
      )
      .run(front, back, input.cardId, input.planId ?? null, input.planId ?? null);
    if (result.changes === 0) throw new Error("card-missing");
    return { id: input.cardId };
  }
  const id = uuidv7(now);
  if (input.planId) {
    if (!input.topicId) throw new Error("topic-missing");
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.planId, input.topicId, front, back, now);
    return { id };
  }
  if (!input.subjectId || !db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(input.subjectId))
    throw new Error("subject-missing");
  db.prepare(
    `INSERT INTO cards (id, subject_id, front, back, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, input.subjectId, front, back, now);
  return { id };
}

export function deleteCard(db: Database.Database, cardId: string): void {
  const row = db
    .prepare(`SELECT seed_key FROM cards WHERE id = ?`)
    .get(cardId) as { seed_key: string | null } | undefined;
  if (!row) throw new Error("card-missing");
  if (row.seed_key) {
    db.prepare(`UPDATE cards SET removed = 1 WHERE id = ?`).run(cardId);
    return;
  }
  db.prepare(`DELETE FROM cards WHERE id = ?`).run(cardId);
}

/** Brings back a seeded card that deleteCard removed. A hand-made card is gone for good, so there is nothing to restore. */
export function restoreCard(db: Database.Database, cardId: string): void {
  const result = db
    .prepare(`UPDATE cards SET removed = 0 WHERE id = ?`)
    .run(cardId);
  if (result.changes === 0) throw new Error("card-missing");
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

export function setSuspended(
  db: Database.Database,
  cardId: string,
  suspended: boolean,
): void {
  const result = db
    .prepare(`UPDATE cards SET suspended = ? WHERE id = ?`)
    .run(suspended ? 1 : 0, cardId);
  if (result.changes === 0) throw new Error("card-missing");
}
