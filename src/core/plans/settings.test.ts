import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { planFootprint, savePlanSettings, setPlanArchived } from "./settings";
import { requests } from "../../shared/ipc";
import { PLAN_TITLE_MAX } from "../../shared/plan-file";

describe("plan settings", () => {
  it("changes editable fields while keeping content language and material", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO plans(id,title,status,content_language,created_at,updated_at) VALUES('p','Old','ready','it',1,1)",
    ).run();
    expect(
      savePlanSettings(
        db,
        { planId: "p", title: "  Mechanics  ", target: 0.8, sessions: [{ date: 1000 }] },
        2000,
      ),
    ).toEqual({ ok: true });
    expect(
      db
        .prepare(
          "SELECT title,target,exam_at,content_language,updated_at FROM plans",
        )
        .get(),
    ).toEqual({
      title: "Mechanics",
      target: 0.8,
      exam_at: 1000,
      content_language: "it",
      updated_at: 2000,
    });
    expect(() =>
      savePlanSettings(db, {
        planId: "p",
        title: " ",
        target: 0.8,
        sessions: [],
      }),
    ).toThrow();
    expect(() =>
      savePlanSettings(db, {
        planId: "p",
        title: "Fine",
        target: 1.1,
        sessions: [],
      }),
    ).toThrow();
    expect(() =>
      savePlanSettings(db, {
        planId: "missing",
        title: "Fine",
        target: 0.8,
        sessions: [],
      }),
    ).toThrow("plan-missing-or-building");
    expect(db.prepare("SELECT title FROM plans").get()).toEqual({
      title: "Mechanics",
    });
    db.close();
  });
});

describe("plan footprint", () => {
  it("counts what deleting the plan would remove, archived or not, and nothing of another plan", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Fisica','ready',1,1),('q','Chimica','ready',1,1);
      INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('t1','p','Cinematica',0,1),('t2','p','Dinamica',1,1),('t3','q','Atomi',0,1);
      INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES
        ('l1','p','t1','lesson','{}',1),('l2','p','t2','lesson','{}',1),('lq','q','t3','lesson','{}',1),
        ('qz','p','t1','quiz','{}',1),('dg','p',NULL,'diagnostic','{}',1),('sm','p',NULL,'simulation','{}',1),('rv','p',NULL,'review','{}',1);
      INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES
        ('a1','p','qz',1,2),('a2','p','qz',3,NULL),('a3','p','dg',1,2),('a4','p','sm',1,2),('a5','p','sm',3,NULL),('a6','p','rv',1,2),('a7','p','rv',3,NULL);
      INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
        ('c1','p','t1','a','b',1),('c2','p','t1','a','b',1),('c3','q','t3','a','b',1);
      -- A card the student removed: the card browser can still bring it back, and the delete removes it too.
      UPDATE cards SET removed = 1 WHERE id = 'c2';
      -- A topic a rebuild set aside, with its lesson and a flashcard: the delete removes them with the plan.
      INSERT INTO topics(id,plan_id,title,position,created_at,archived_at) VALUES('t4','p','Statica',2,1,4);
      INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('l4','p','t4','lesson','{}',1);
      INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('c4','p','t4','a','b',1);
    `);
    const expected = { topics: 3, lessons: 3, quizzes: 3, simulations: 1, cards: 3 };
    expect(planFootprint(db, "p")).toEqual(expected);
    // The card browser leaves archived plans out; the footprint must not.
    setPlanArchived(db, "p", true, 5);
    expect(planFootprint(db, "p")).toEqual(expected);
    expect(() => planFootprint(db, "missing")).toThrow("plan-missing");
    db.close();
  });
});

describe("plan title limit", () => {
  it("accepts the same longest title when creating a plan and in its settings", () => {
    const create = (title: string) =>
      requests["plans.create"].input.safeParse({ title, sourceIds: [] }).success;
    const settings = (title: string) =>
      requests["plans.settings"].input.safeParse({ planId: "p", title, target: 0.8, sessions: [] })
        .success;
    expect(create("a".repeat(PLAN_TITLE_MAX))).toBe(true);
    expect(settings("a".repeat(PLAN_TITLE_MAX))).toBe(true);
    expect(create("a".repeat(PLAN_TITLE_MAX + 1))).toBe(false);
    expect(settings("a".repeat(PLAN_TITLE_MAX + 1))).toBe(false);
    expect(create("   ")).toBe(false);
  });
});
