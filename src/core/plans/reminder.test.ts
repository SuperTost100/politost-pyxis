import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { reminderSummary } from "./reminder";

const NOON = new Date(2026, 9, 13, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function database() {
  const db = openDatabase(":memory:");
  const plan = (
    id: string,
    title: string,
    status: string,
    examAt: number | null,
  ) => {
    db.prepare(
      "INSERT INTO plans (id, title, status, exam_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    ).run(id, title, status, examAt);
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'T', 0, 1)",
    ).run(`${id}-t`, id);
  };
  let n = 0;
  const cards = (planId: string, count: number) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      db.prepare(
        "INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at) VALUES (?, ?, ?, ?, 'b', 'sources', 1)",
      ).run(`c${n}`, planId, `${planId}-t`, `front ${n}`);
    }
  };
  return { db, plan, cards };
}

describe("reminderSummary", () => {
  it("is null with no cards due", () => {
    const { db, plan } = database();
    expect(reminderSummary(db, NOON)).toBeNull();
    plan("a", "Analisi", "ready", null);
    expect(reminderSummary(db, NOON)).toBeNull();
    db.close();
  });

  it("adds the cards of every plan and names the plan whose exam is nearest", () => {
    const { db, plan, cards } = database();
    plan("a", "Analisi", "ready", NOON + 3 * DAY);
    plan("f", "Fisica", "ready", NOON + 10 * DAY);
    plan("g", "Geometria", "ready", NOON - 5 * DAY);
    plan("n", "Nuovo", "ready", null);
    cards("a", 4);
    cards("f", 6);
    cards("g", 10);
    expect(reminderSummary(db, NOON)).toEqual({
      dueCards: 20,
      planId: "a",
      planTitle: "Analisi",
      daysToExam: 3,
    });
    db.close();
  });

  it("falls back to the plan with the most cards when no exam is ahead, and skips plans still building", () => {
    const { db, plan, cards } = database();
    plan("a", "Analisi", "ready", null);
    plan("g", "Geometria", "ready", NOON - 5 * DAY);
    plan("b", "In costruzione", "building", NOON + DAY);
    cards("a", 2);
    cards("g", 7);
    cards("b", 5);
    expect(reminderSummary(db, NOON)).toEqual({
      dueCards: 9,
      planId: "g",
      planTitle: "Geometria",
      daysToExam: null,
    });
    db.close();
  });

  it("leaves out suspended and removed cards", () => {
    const { db, plan, cards } = database();
    plan("a", "Analisi", "ready", null);
    cards("a", 3);
    db.prepare("UPDATE cards SET suspended = 1 WHERE id = 'c1'").run();
    db.prepare("UPDATE cards SET removed = 1 WHERE id = 'c2'").run();
    expect(reminderSummary(db, NOON)?.dueCards).toBe(1);
    db.close();
  });
});
