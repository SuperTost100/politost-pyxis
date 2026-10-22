import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection";
import { listPlans, planGuide } from "../plans/create";
import { planMastery, planSeries } from "../plans/progress";
import { browseCards } from "../study/cardBrowser";
import {
  countDueCards,
  dueCards,
  newCardsLeftToday,
  queueCounts,
  rateCard,
  undoRating,
} from "../study/cards";
import { currentSelfRatings } from "../study/selfRating";
import { smartAnswers } from "../study/smartText";

const WATCHED = ["card_reviews", "learning_events"];
const KEYWORDS = new Set([
  "where",
  "on",
  "join",
  "left",
  "inner",
  "cross",
  "order",
  "group",
  "limit",
  "set",
  "values",
  "union",
  "and",
  "or",
  "using",
  "as",
]);

/** Every SQL text the code prepares while `run` executes. */
function preparedDuring(db: Database.Database, run: () => void): Set<string> {
  const seen = new Set<string>();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    seen.add(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    run();
  } finally {
    db.prepare = prepare;
  }
  return seen;
}

/** The plan steps that read all of card_reviews or learning_events, found by the table's name or its alias. */
function fullScans(db: Database.Database, sql: string): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(
    /\b(card_reviews|learning_events)\b(?:\s+(?:AS\s+)?(\w+))?/gi,
  )) {
    names.add(match[1]!.toLowerCase());
    if (match[2] && !KEYWORDS.has(match[2].toLowerCase())) names.add(match[2]);
  }
  if (!WATCHED.some((table) => names.has(table))) return [];
  const params = Array<null>((sql.match(/\?/g) ?? []).length).fill(null);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{
    detail: string;
  }>;
  return plan
    .map((row) => row.detail)
    .filter((detail) => {
      // An automatic index is built by reading the whole table each time the query runs.
      const scanned =
        /^SCAN (\w+)/.exec(detail)?.[1] ??
        /^SEARCH (\w+) USING AUTOMATIC/.exec(detail)?.[1];
      return scanned !== undefined && names.has(scanned);
    });
}

describe("hot queries", () => {
  it("never read all of card_reviews or learning_events", () => {
    const db = openDatabase(":memory:");
    const now = 1_800_000_000_000;
    db.exec(`
      INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Physics', 'ready', 1, 1);
      INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Motion', 0, 1);
      INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('lesson', 'p', 't', 'lesson', '{"markdown":"Text"}', 1);
      INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES ('c1', 'p', 't', 'Velocità', 'Spazio su tempo', 1), ('c2', 'p', 't', 'Forza', 'Massa per accelerazione', 1);
      INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('r1', 'c1', 'good', '{"intervalDays":1,"ease":2.5,"dueAt":2}', 1);
      INSERT INTO learning_events (id, kind, plan_id, topic_id, item_id, payload_json, created_at) VALUES
        ('e1', 'answer_given', 'p', 't', NULL, '{"score":1,"evidenceKind":"self","exerciseId":"x","rating":"got"}', 1),
        ('e2', 'answer_given', 'p', 't', 'lesson', '{"score":1,"evidenceKind":"check","blockId":"b"}', 2);
    `);
    const sql = preparedDuring(db, () => {
      countDueCards(db, "p", now);
      countDueCards(db, "p", now, "t");
      dueCards(db, "p", now);
      dueCards(db, "p", now, "t", ["c1", "c2"]);
      queueCounts(db, "p", "t");
      planMastery(db, "p", now);
      listPlans(db, now);
      planGuide(db, "p", now);
      planSeries(db, "p", now);
      currentSelfRatings(db, "t", now);
      smartAnswers(db, "lesson");
      browseCards(db, { query: "velocita" }, now);
      newCardsLeftToday(db, "p", now);
      const { reviewId } = rateCard(db, "c2", "good", now);
      undoRating(db, reviewId);
      browseCards(db, { status: "leech" }, now);
      browseCards(db, { status: "due", offset: 1 }, now);
    });
    const scans = [...sql].flatMap((text) =>
      fullScans(db, text).map(
        (detail) => `${detail} in: ${text.replace(/\s+/g, " ").trim()}`,
      ),
    );
    expect(sql.size).toBeGreaterThan(20);
    expect(scans).toEqual([]);
    db.close();
  });
});
