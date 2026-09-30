import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../shared/ids";
import { openDatabase } from "../db/connection";
import { dueCards, rateCard, seedCards } from "./cards";

const MS_PER_DAY = 86_400_000;
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
    const count = db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE plan_id = ?`).get(planId) as {
      n: number;
    };
    expect(count.n).toBe(2);
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
    expect(next.dueAt).toBe(T0 + MS_PER_DAY);
    expect(dueCards(db, planId, T0)).toHaveLength(0);
    expect(dueCards(db, planId, T0 + MS_PER_DAY)).toHaveLength(1);
  });
});
