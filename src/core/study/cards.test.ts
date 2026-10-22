import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../shared/ids";
import { openDatabase } from "../db/connection";
import {
  countDueCards,
  deleteCard,
  dueCards,
  newCardsLeftToday,
  newCardsPerDay,
  queueCounts,
  rateCard,
  saveCard,
  setNewCardsPerDay,
  setSuspended,
  undoRating,
} from "./cards";
import { pathState, planGuide } from "../plans/create";
import { seedCards } from "./test-study";

const T0 = Date.UTC(2026, 2, 15, 10, 0, 0);

function planWithTopic(db: ReturnType<typeof openDatabase>) {
  const planId = uuidv7();
  const topicId = uuidv7();
  db.prepare(
    `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
  ).run(planId);
  db.prepare(
    `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Moti', 0, 1)`,
  ).run(topicId, planId);
  return { planId, topicId };
}

describe("cards", () => {
  it("seed skips duplicate fronts for the same plan", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const first = seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "Cos'e la forza?", back: "F = ma" }],
    });
    const second = seedCards(db, {
      planId,
      topicId,
      pairs: [
        { front: "  Cos'e la forza?  ", back: "altro" },
        { front: "Unita di energia?", back: "J" },
      ],
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM cards WHERE plan_id = ?`)
      .get(planId) as {
      n: number;
    };
    expect(count.n).toBe(2);
  });

  it("keeps the same front on two topics", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const other = uuidv7();
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Intro', 1, 1)`,
    ).run(other, planId);
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "1. Introduction · 1", back: "A" }],
    });
    const second = seedCards(db, {
      planId,
      topicId: other,
      pairs: [{ front: "1. Introduction · 1", back: "B" }],
    });
    expect(second).toHaveLength(1);
    const due = dueCards(db, planId, T0, other);
    expect(due.map((card) => card.back)).toEqual(["B"]);
  });

  it("counts every due card for the suggestion, not just one session's worth", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    // Above the 25 cards, so the daily limit of new cards does not hide any.
    setNewCardsPerDay(db, 30);
    seedCards(db, {
      planId,
      topicId,
      pairs: Array.from({ length: 25 }, (_, index) => ({
        front: `Domanda ${index}`,
        back: `Risposta ${index}`,
      })),
    });
    expect(dueCards(db, planId, T0)).toHaveLength(20);
    expect(planGuide(db, planId, T0)?.topics[0]?.dueCards).toBe(25);
    // Today's list counts them per plan instead, so it asks the path not to.
    expect(pathState(db, planId, T0, { dueCards: false })?.topics[0]?.dueCards).toBe(0);
  });

  it("takes the review stored last as the latest when two share a time, here and in undo", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    seedCards(db, { planId, topicId, pairs: [{ front: "F", back: "B" }] });
    const cardId = (db.prepare(`SELECT id FROM cards`).get() as { id: string }).id;
    const review = db.prepare(
      `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES (?, ?, 'good', ?, ?)`,
    );
    // Inserted in reverse ID order, so neither the ID nor chance picks the second one.
    review.run("z-first", cardId, JSON.stringify({ intervalDays: 30, ease: 2.5, dueAt: T0 + 30 * 86_400_000 }), T0 - 1);
    review.run("a-second", cardId, JSON.stringify({ intervalDays: 0, ease: 2.5, dueAt: T0 - 1 }), T0 - 1);
    expect(dueCards(db, planId, T0).map((card) => card.id)).toEqual([cardId]);
    expect(() => undoRating(db, "z-first")).toThrow("review-not-latest");
  });

  it("treats a new card as due now", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "Velocita media?", back: "Delta s / Delta t" }],
    });
    const due = dueCards(db, planId, T0);
    expect(due).toHaveLength(1);
    expect(due[0]?.state.dueAt).toBe(T0);
    expect(due[0]?.sectionPath).toBeNull();
  });

  it("keeps the passage title on a seeded card", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const sourceId = uuidv7();
    const passageId = uuidv7();
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'smartbook', 'Demo', 'ready', 1, 1)`,
    ).run(sourceId);
    db.prepare(
      `INSERT INTO passages (id, source_id, text, section_path, created_at)
       VALUES (?, ?, 'Il vettore.', '1. Moti', 1)`,
    ).run(passageId, sourceId);
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "1. Moti · 1", back: "Il vettore.", passageId }],
    });
    const due = dueCards(db, planId, T0)[0];
    expect(due?.sectionPath).toBe("1. Moti");
    expect(due?.passageId).toBe(passageId);
    expect(due?.sourceId).toBe(sourceId);
  });

  it("fills a missing passage on a card that already exists", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const sourceId = uuidv7();
    const passageId = uuidv7();
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'smartbook', 'Demo', 'ready', 1, 1)`,
    ).run(sourceId);
    db.prepare(
      `INSERT INTO passages (id, source_id, text, section_path, locator_json, created_at)
       VALUES (?, ?, 'Il vettore.', '1. Moti', '{"chapter":1}', 1)`,
    ).run(passageId, sourceId);
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "1. Moti · 1", back: "Il vettore." }],
    });
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "1. Moti · 1", back: "Il vettore.", passageId }],
    });
    const due = dueCards(db, planId, T0)[0];
    expect(due?.passageId).toBe(passageId);
    expect(due?.chapter).toBe(1);
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM cards WHERE plan_id = ?`)
      .get(planId) as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("leaves the passage empty when the stored answer differs", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const sourceId = uuidv7();
    const passageId = uuidv7();
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'smartbook', 'Demo', 'ready', 1, 1)`,
    ).run(sourceId);
    db.prepare(
      `INSERT INTO passages (id, source_id, text, section_path, created_at)
       VALUES (?, ?, 'Altro.', '2. Forze', 1)`,
    ).run(passageId, sourceId);
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "1. Moti · 1", back: "Il vettore." }],
    });
    seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "1. Moti · 1", back: "Altro.", passageId }],
    });
    expect(dueCards(db, planId, T0)[0]?.passageId).toBeNull();
  });

  it("after a good rating the card is not due until dueAt", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const [cardId] = seedCards(db, {
      planId,
      topicId,
      pairs: [{ front: "Lavoro?", back: "W = F s" }],
    });
    const next = rateCard(db, cardId!, "good", T0);
    expect(next.dueAt).toBeGreaterThan(T0);
    expect(dueCards(db, planId, T0)).toHaveLength(0);
    expect(dueCards(db, planId, next.dueAt)).toHaveLength(1);
    const event = db
      .prepare(
        `SELECT topic_id, payload_json FROM learning_events WHERE kind = 'card_rated'`,
      )
      .get() as { topic_id: string; payload_json: string };
    expect(event.topic_id).toBe(topicId);
    expect(JSON.parse(event.payload_json)).toEqual({ score: 1, cardId });
  });

  it("counts new, learning and mastered cards, and skips a suspended one", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const [freshId, learningId] = seedCards(db, {
      planId,
      topicId,
      pairs: [
        { front: "Nuova", back: "A" },
        { front: "In corso", back: "B" },
      ],
    });
    rateCard(db, learningId!, "good", T0);
    const mastered = saveCard(
      db,
      { planId, topicId, front: "Lunga", back: "C" },
      T0,
    );
    db.prepare(
      `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at)
       VALUES (?, ?, 'easy', ?, ?)`,
    ).run(
      uuidv7(T0),
      mastered.id,
      JSON.stringify({ intervalDays: 21, ease: 2.5, dueAt: T0 }),
      T0,
    );
    const parked = saveCard(
      db,
      { planId, topicId, front: "Sospesa", back: "D" },
      T0 + 1,
    );
    setSuspended(db, parked.id, true);
    expect(queueCounts(db, planId, topicId)).toEqual({
      fresh: 1,
      learning: 1,
      mastered: 1,
    });
    expect(dueCards(db, planId, T0).some((card) => card.id === parked.id)).toBe(
      false,
    );
    expect(dueCards(db, planId, T0).some((card) => card.id === freshId)).toBe(
      true,
    );
    saveCard(db, {
      planId,
      topicId,
      cardId: freshId,
      front: "Nuova",
      back: "Aggiornata",
    });
    expect(
      dueCards(db, planId, T0).find((card) => card.id === freshId)?.back,
    ).toBe("Aggiornata");
    deleteCard(db, freshId!);
    expect(queueCounts(db, planId, topicId).fresh).toBe(0);
  });

  it("keeps a generated card gone after its front changes or it is deleted", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const pair = { front: "Forza", back: "F = ma" };
    const [id] = seedCards(db, { planId, topicId, pairs: [pair] });
    saveCard(db, {
      planId,
      topicId,
      cardId: id,
      front: "Forza netta",
      back: "F = ma",
    });
    seedCards(db, { planId, topicId, pairs: [pair] });
    const rows = db
      .prepare(`SELECT front, removed FROM cards WHERE plan_id = ?`)
      .all(planId) as Array<{
      front: string;
      removed: number;
    }>;
    expect(rows).toEqual([{ front: "Forza netta", removed: 0 }]);
    deleteCard(db, id!);
    seedCards(db, { planId, topicId, pairs: [pair] });
    expect(dueCards(db, planId, T0)).toHaveLength(0);
    expect(queueCounts(db, planId, topicId)).toEqual({
      fresh: 0,
      learning: 0,
      mastered: 0,
    });
  });
  it("rejects duplicate, suspended and removed reviews without adding events", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const { id } = saveCard(db, { planId, topicId, front: "Q", back: "A" }, T0);
    const next = rateCard(db, id, "again", T0);
    expect(() => rateCard(db, id, "good", T0)).toThrow("card-not-due");
    expect(db.prepare("SELECT COUNT(*) n FROM card_reviews").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) n FROM learning_events").get()).toEqual({
      n: 1,
    });
    setSuspended(db, id, true);
    expect(() => rateCard(db, id, "good", next.dueAt)).toThrow(
      "card-suspended",
    );
    setSuspended(db, id, false);
    rateCard(db, id, "good", next.dueAt);
    deleteCard(db, id);
    expect(() => rateCard(db, id, "good", next.dueAt + 1)).toThrow(
      "card-missing",
    );
    db.close();
  });

  it("rolls back a review if its learning event cannot be saved", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const { id } = saveCard(db, { planId, topicId, front: "Q", back: "A" }, T0);
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON learning_events BEGIN SELECT RAISE(ABORT, 'test-full'); END",
    );
    expect(() => rateCard(db, id, "good", T0)).toThrow("test-full");
    expect(db.prepare("SELECT COUNT(*) n FROM card_reviews").get()).toEqual({
      n: 0,
    });
    expect(dueCards(db, planId, T0)).toHaveLength(1);
    db.close();
  });
});

function seedMany(
  db: ReturnType<typeof openDatabase>,
  planId: string,
  topicId: string,
  count: number,
  from = 0,
) {
  return seedCards(db, {
    planId,
    topicId,
    pairs: Array.from({ length: count }, (_, index) => ({
      front: `Domanda ${from + index}`,
      back: `Risposta ${from + index}`,
    })),
  });
}

describe("daily limit of new cards", () => {
  it("introduces 20 new cards a day by default and counts the ones rated today", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const ids = seedMany(db, planId, topicId, 30);
    expect(newCardsPerDay(db)).toBe(20);
    expect(countDueCards(db, planId, T0)).toBe(20);
    expect(countDueCards(db, planId, T0, topicId)).toBe(20);
    // The oldest new cards come first.
    expect(dueCards(db, planId, T0).map((card) => card.id)).toEqual(
      ids.slice(0, 20),
    );
    for (const id of ids.slice(0, 5)) rateCard(db, id, "good", T0);
    // Five introduced today: 15 more new cards, and the rated ones wait for their learning step.
    expect(newCardsLeftToday(db, planId, T0)).toEqual({ limit: 20, left: 15 });
    expect(countDueCards(db, planId, T0)).toBe(15);
    // A rated card that comes back is not new, so it does not use the allowance.
    expect(countDueCards(db, planId, T0 + 3_600_000)).toBe(20);
    // The next day the allowance is whole again.
    const tomorrow = T0 + 86_400_000;
    expect(newCardsLeftToday(db, planId, tomorrow).left).toBe(20);
    db.close();
  });

  it("follows the setting, and 0 introduces no new card", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    seedMany(db, planId, topicId, 10);
    expect(setNewCardsPerDay(db, 3)).toBe(3);
    expect(dueCards(db, planId, T0)).toHaveLength(3);
    setNewCardsPerDay(db, 0);
    expect(countDueCards(db, planId, T0)).toBe(0);
    expect(setNewCardsPerDay(db, 5000)).toBe(999);
    db.close();
  });

  it("gives a topic its own new cards within the plan's allowance", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const other = uuidv7();
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Forze', 1, 1)`,
    ).run(other, planId);
    setNewCardsPerDay(db, 4);
    seedMany(db, planId, topicId, 6);
    const later = seedMany(db, planId, other, 3, 100);
    // The older topic fills the plan-wide queue; the newer topic still shows its own cards.
    expect(countDueCards(db, planId, T0)).toBe(4);
    expect(dueCards(db, planId, T0, other).map((card) => card.id)).toEqual(
      later,
    );
    rateCard(db, later[0]!, "good", T0);
    rateCard(db, later[1]!, "good", T0);
    expect(countDueCards(db, planId, T0, topicId)).toBe(2);
    db.close();
  });

  it("does not shorten a stored review queue", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    setNewCardsPerDay(db, 2);
    const ids = seedMany(db, planId, topicId, 4);
    expect(dueCards(db, planId, T0, undefined, ids)).toHaveLength(4);
    db.close();
  });
});

describe("undo a rating", () => {
  const events = (db: ReturnType<typeof openDatabase>) =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'card_rated'",
        )
        .get() as { n: number }
    ).n;

  it("puts a new card back as new and due, without its review or event", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const { id } = saveCard(db, { planId, topicId, front: "Q", back: "A" }, T0);
    const rated = rateCard(db, id, "again", T0);
    expect(dueCards(db, planId, T0)).toHaveLength(0);
    expect(undoRating(db, rated.reviewId)).toEqual({ cardId: id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_reviews").get()).toEqual({
      n: 0,
    });
    expect(events(db)).toBe(0);
    const due = dueCards(db, planId, T0);
    expect(due.map((card) => card.id)).toEqual([id]);
    expect(due[0]!.state.fsrs).toBeUndefined();
    expect(newCardsLeftToday(db, planId, T0).left).toBe(20);
    db.close();
  });

  it("restores the state of the rating before, and the card can be rated again", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const { id } = saveCard(db, { planId, topicId, front: "Q", back: "A" }, T0);
    const first = rateCard(db, id, "good", T0);
    const second = rateCard(db, id, "again", first.dueAt);
    undoRating(db, second.reviewId);
    expect(events(db)).toBe(1);
    const due = dueCards(db, planId, first.dueAt);
    expect(due[0]!.state).toMatchObject({ dueAt: first.dueAt, fsrs: first.fsrs });
    expect(rateCard(db, id, "easy", first.dueAt).dueAt).toBeGreaterThan(
      second.dueAt,
    );
    db.close();
  });

  it("only takes back the card's latest rating, and only once", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = planWithTopic(db);
    const { id } = saveCard(db, { planId, topicId, front: "Q", back: "A" }, T0);
    const first = rateCard(db, id, "good", T0);
    const second = rateCard(db, id, "good", first.dueAt);
    expect(() => undoRating(db, first.reviewId)).toThrow("review-not-latest");
    undoRating(db, second.reviewId);
    expect(() => undoRating(db, second.reviewId)).toThrow("review-missing");
    expect(events(db)).toBe(1);
    db.close();
  });
});
