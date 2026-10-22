import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { seedCards } from "./test-study";
import { retireExerciseCards } from "./exerciseCards";

const LONG = `Determinare il dominio naturale della funzione f(x)=sqrt(ln(x+2))/(x-1). ${"Spiega ogni passaggio. ".repeat(30)}`;

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Analisi', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Domini', 0, 1)",
  ).run();
  const exercise = db.prepare(
    "INSERT INTO exercises (id, prompt, answer, locator_json, created_at) VALUES (?, ?, ?, '{}', 1)",
  );
  exercise.run("e1", "Calcola 2+2.", "4");
  exercise.run("e2", LONG, "Passo 1. Passo 2.");
  exercise.run("e3", "Senza soluzione.", null);
  return db;
}

const removed = (db: ReturnType<typeof fixture>, id: string) =>
  (
    db.prepare("SELECT removed FROM cards WHERE id = ?").get(id) as {
      removed: number;
    }
  ).removed;

describe("retireExerciseCards", () => {
  it("moves only the cards seeded from exercises to Removed, keeping reviews", () => {
    const db = fixture();
    const base = { planId: "plan", topicId: "topic" };
    const [short, long, noAnswer, other] = seedCards(db, {
      ...base,
      pairs: [
        { front: "Calcola 2+2.", back: "4" },
        { front: LONG.slice(0, 400), back: "Passo 1. Passo 2." },
        { front: "Senza soluzione.", back: "x" },
        { front: "Cos'è un dominio?", back: "L'insieme dove f è definita." },
      ],
    }) as [string, string, string, string];
    // A hand-made card with the same text as an exercise has no seed key.
    db.prepare(
      "INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES ('mine', 'plan', 'topic', 'Calcola 2+3.', '5', 1)",
    ).run();
    db.prepare(
      "INSERT INTO exercises (id, prompt, answer, locator_json, created_at) VALUES ('e4', 'Calcola 2+3.', '5', '{}', 1)",
    ).run();
    // A generated card carries a template and a gen: seed key, even if its front repeats an exercise prompt.
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, prompt_template, seed_key, created_at)
       VALUES ('gen', 'plan', 'topic', 'Calcola 2+2.', '4', 'sources', 'cards.generate', 'gen:p:calcola 2+2.', 1)`,
    ).run();
    // The student rewrote this one, so its front no longer equals its seed key.
    db.prepare("UPDATE cards SET front = 'Dominio di ln?' WHERE id = ?").run(
      long,
    );
    const [edited] = seedCards(db, {
      ...base,
      pairs: [{ front: "Calcola 2+2 (bis)", back: "4" }],
    });
    db.prepare(
      "INSERT INTO exercises (id, prompt, answer, locator_json, created_at) VALUES ('e5', 'Calcola 2+2 (bis)', '4', '{}', 1)",
    ).run();
    db.prepare(
      "UPDATE cards SET front = 'Quanto fa due più due?' WHERE id = ?",
    ).run(edited);
    db.prepare(
      "INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('r', ?, 'good', '{}', 1)",
    ).run(short);

    expect(retireExerciseCards(db)).toBe(1);
    expect(removed(db, short)).toBe(1);
    expect(removed(db, long)).toBe(0);
    expect(removed(db, noAnswer)).toBe(0);
    expect(removed(db, other)).toBe(0);
    expect(removed(db, "mine")).toBe(0);
    expect(removed(db, "gen")).toBe(0);
    expect(removed(db, edited!)).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM card_reviews WHERE card_id = ?")
        .get(short),
    ).toEqual({ n: 1 });
    db.close();
  });

  it("cuts a long prompt at 400 characters, as the seeding did", () => {
    const db = fixture();
    const [id] = seedCards(db, {
      planId: "plan",
      topicId: "topic",
      pairs: [{ front: LONG.slice(0, 400), back: "Passo 1." }],
    });
    expect(retireExerciseCards(db)).toBe(1);
    expect(removed(db, id!)).toBe(1);
    db.close();
  });

  it("runs once: a restored card stays restored", () => {
    const db = fixture();
    const [id] = seedCards(db, {
      planId: "plan",
      topicId: "topic",
      pairs: [{ front: "Calcola 2+2.", back: "4" }],
    });
    expect(retireExerciseCards(db)).toBe(1);
    db.prepare("UPDATE cards SET removed = 0 WHERE id = ?").run(id);
    expect(retireExerciseCards(db)).toBe(0);
    expect(removed(db, id!)).toBe(0);
    db.close();
  });
});
