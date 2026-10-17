import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { browseCards, foldText } from "./cardBrowser";
import {
  deleteCard,
  rateCard,
  restoreCard,
  saveCard,
  seedCards,
  setSuspended,
} from "./cards";

const T0 = Date.UTC(2026, 2, 15, 10, 0, 0);

type Db = ReturnType<typeof openDatabase>;

function subject(db: Db, id: string, name: string, position: number) {
  db.prepare(
    `INSERT INTO subjects (id, name, position, created_at) VALUES (?, ?, ?, 1)`,
  ).run(id, name, position);
}

function plan(db: Db, id: string, title: string, subjectId: string | null) {
  db.prepare(
    `INSERT INTO plans (id, subject_id, title, status, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', 1, 1)`,
  ).run(id, subjectId, title);
}

function topic(
  db: Db,
  id: string,
  planId: string,
  title: string,
  position = 0,
) {
  db.prepare(
    `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, ?, ?, 1)`,
  ).run(id, planId, title, position);
}

/** Two subjects out of alphabetical order, one exam with no subject, and a few cards in each. */
function library() {
  const db = openDatabase(":memory:");
  subject(db, "s-chem", "Chimica", 1);
  subject(db, "s-phys", "Fisica", 0);
  plan(db, "p-chem", "Chimica generale", "s-chem");
  plan(db, "p-phys", "Fisica 1", "s-phys");
  plan(db, "p-none", "Appunti sparsi", null);
  topic(db, "t-atoms", "p-chem", "Atomi");
  topic(db, "t-dyn", "p-phys", "Dinamica", 1);
  topic(db, "t-kin", "p-phys", "Cinematica", 0);
  topic(db, "t-misc", "p-none", "Varie");
  seedCards(db, {
    planId: "p-phys",
    topicId: "t-dyn",
    pairs: [
      {
        front: "Perché un corpo accelera?",
        back: "Perché agisce una forza: $F=ma$.",
      },
      { front: "Unità della forza?", back: "Il newton." },
    ],
  });
  seedCards(db, {
    planId: "p-phys",
    topicId: "t-kin",
    pairs: [{ front: "Velocità media?", back: "Spazio diviso tempo." }],
  });
  seedCards(db, {
    planId: "p-chem",
    topicId: "t-atoms",
    pairs: [
      { front: "Numero atomico?", back: "Protoni nel nucleo." },
      {
        front: "{{c1::Elettroni}} orbitano il nucleo.",
        back: "Modello di Bohr.",
      },
    ],
  });
  seedCards(db, {
    planId: "p-none",
    topicId: "t-misc",
    pairs: [{ front: "Sparsa", back: "Senza materia." }],
  });
  return db;
}

const fronts = (db: Db, input: Parameters<typeof browseCards>[1] = {}) =>
  browseCards(db, input, T0).cards.map((card) => card.front);
const idOf = (db: Db, front: string) =>
  (
    db.prepare(`SELECT id FROM cards WHERE front = ?`).get(front) as {
      id: string;
    }
  ).id;

describe("card browser", () => {
  it("groups cards by subject in the saved order, with the no-subject group last", () => {
    const db = library();
    const result = browseCards(db, {}, T0);
    expect(result.total).toBe(6);
    expect(result.groups).toEqual([
      { subjectId: "s-phys", subject: "Fisica", count: 3 },
      { subjectId: "s-chem", subject: "Chimica", count: 2 },
      { subjectId: null, subject: null, count: 1 },
    ]);
    expect(result.cards.map((card) => card.subjectName)).toEqual([
      "Fisica",
      "Fisica",
      "Fisica",
      "Chimica",
      "Chimica",
      null,
    ]);
  });

  it("orders by exam, then topic position, then creation within a subject", () => {
    const db = library();
    expect(fronts(db).slice(0, 3)).toEqual([
      "Velocità media?",
      "Perché un corpo accelera?",
      "Unità della forza?",
    ]);
  });

  it("reports exams and topics for the filters, whatever the search", () => {
    const db = library();
    const result = browseCards(db, { query: "newton" }, T0);
    expect(result.cards).toHaveLength(1);
    // Subject order (Fisica, Chimica), then the exam with no subject.
    expect(result.plans.map((item) => item.id)).toEqual([
      "p-phys",
      "p-chem",
      "p-none",
    ]);
    expect(result.plans[0]).toMatchObject({
      subjectId: "s-phys",
      subject: "Fisica",
    });
    expect(
      result.topics
        .filter((item) => item.planId === "p-phys")
        .map((item) => item.title),
    ).toEqual(["Cinematica", "Dinamica"]);
  });

  it("finds accented text without the accent, and any case", () => {
    const db = library();
    expect(fronts(db, { query: "perche" })).toEqual([
      "Perché un corpo accelera?",
    ]);
    expect(fronts(db, { query: "PERCHÉ" })).toEqual([
      "Perché un corpo accelera?",
    ]);
    expect(fronts(db, { query: "velocita" })).toEqual(["Velocità media?"]);
    // The back counts too.
    expect(fronts(db, { query: "nucleo" })).toHaveLength(2);
  });

  it("folds curly and straight apostrophes together", () => {
    const db = library();
    saveCard(db, {
      planId: "p-phys",
      topicId: "t-dyn",
      front: "Cos’è l’energia?",
      back: "Capacità di compiere lavoro.",
    });
    expect(fronts(db, { query: "cos'e l'energia" })).toEqual([
      "Cos’è l’energia?",
    ]);
    expect(foldText("Perché ’")).toBe("perche '");
  });

  it("needs every word, in any order", () => {
    const db = library();
    expect(fronts(db, { query: "forza  accelera" })).toEqual([
      "Perché un corpo accelera?",
    ]);
    expect(fronts(db, { query: "forza chimica" })).toEqual([]);
  });

  it("searches the current text after an edit and finds a card added since the last search", () => {
    const db = library();
    expect(fronts(db, { query: "protoni" })).toEqual(["Numero atomico?"]);
    saveCard(db, {
      planId: "p-chem",
      topicId: "t-atoms",
      cardId: idOf(db, "Numero atomico?"),
      front: "Numero atomico?",
      back: "Quanti nucleoni carichi.",
    });
    saveCard(db, {
      planId: "p-chem",
      topicId: "t-atoms",
      front: "Isotopi?",
      back: "Stessi protoni, neutroni diversi.",
    });
    expect(fronts(db, { query: "protoni" })).toEqual(["Isotopi?"]);
    expect(fronts(db, { query: "nucleoni" })).toEqual(["Numero atomico?"]);
  });

  it("searches a cloze by its text, not by its markup", () => {
    const db = library();
    expect(fronts(db, { query: "elettroni orbitano" })).toHaveLength(1);
    expect(fronts(db, { query: "c1" })).toEqual([]);
  });

  it("filters by exam and by topic", () => {
    const db = library();
    expect(browseCards(db, { planId: "p-chem" }, T0).total).toBe(2);
    expect(fronts(db, { planId: "p-phys", topicId: "t-kin" })).toEqual([
      "Velocità media?",
    ]);
    // A topic of another exam matches nothing.
    expect(fronts(db, { planId: "p-chem", topicId: "t-kin" })).toEqual([]);
    expect(fronts(db, { topicId: "t-misc" })).toEqual(["Sparsa"]);
  });

  it("leaves out the cards of an archived topic, in the list and in the filters", () => {
    const db = library();
    db.prepare(`UPDATE topics SET archived_at = 5 WHERE id = 't-kin'`).run();
    expect(fronts(db)).not.toContain("Velocità media?");
    expect(browseCards(db, {}, T0).topics.map((item) => item.id)).not.toContain(
      "t-kin",
    );
  });

  it("lists a card whose topic is gone", () => {
    const db = library();
    db.prepare(`DELETE FROM topics WHERE id = 't-misc'`).run();
    const card = browseCards(db, {}, T0).cards.find(
      (item) => item.front === "Sparsa",
    );
    expect(card).toMatchObject({
      topicId: null,
      topicTitle: null,
      planTitle: "Appunti sparsi",
    });
  });

  it("shows removed cards only under the removed filter, and restores them", () => {
    const db = library();
    const id = idOf(db, "Numero atomico?");
    deleteCard(db, id);
    expect(fronts(db)).not.toContain("Numero atomico?");
    const removed = browseCards(db, { status: "removed" }, T0);
    expect(removed.cards).toMatchObject([
      { id, removed: true, handMade: false },
    ]);
    restoreCard(db, id);
    expect(fronts(db)).toContain("Numero atomico?");
    expect(browseCards(db, { status: "removed" }, T0).total).toBe(0);
    expect(() => restoreCard(db, "missing")).toThrow("card-missing");
  });

  it("seeding again does not bring a removed card back", () => {
    const db = library();
    deleteCard(db, idOf(db, "Numero atomico?"));
    seedCards(db, {
      planId: "p-chem",
      topicId: "t-atoms",
      pairs: [{ front: "Numero atomico?", back: "Protoni nel nucleo." }],
    });
    expect(fronts(db, { status: "removed" })).toEqual(["Numero atomico?"]);
    expect(fronts(db, { planId: "p-chem" })).toHaveLength(1);
  });

  it("deletes a hand-made card for good and marks it as hand-made", () => {
    const db = library();
    const { id } = saveCard(db, {
      planId: "p-phys",
      topicId: "t-dyn",
      front: "Mia",
      back: "Scheda",
    });
    const card = browseCards(db, { query: "mia" }, T0).cards[0];
    expect(card).toMatchObject({ id, handMade: true });
    deleteCard(db, id);
    expect(browseCards(db, { query: "mia", status: "removed" }, T0).total).toBe(
      0,
    );
    expect(fronts(db, { query: "mia" })).toEqual([]);
  });

  it("shows suspended cards, and filters to them", () => {
    const db = library();
    const id = idOf(db, "Unità della forza?");
    setSuspended(db, id, true);
    const all = browseCards(db, {}, T0).cards;
    expect(all.find((card) => card.id === id)?.suspended).toBe(true);
    expect(fronts(db, { status: "suspended" })).toEqual(["Unità della forza?"]);
    setSuspended(db, id, false);
    expect(fronts(db, { status: "suspended" })).toEqual([]);
  });

  it("tells a new card from a due one and one that waits, from the latest review", () => {
    const db = library();
    const due = idOf(db, "Numero atomico?");
    const waiting = idOf(db, "Velocità media?");
    // An old, short step makes this one due again by T0 + 1 day.
    rateCard(db, due, "again", T0 - 3 * 86_400_000);
    rateCard(db, waiting, "easy", T0);
    const byId = new Map(
      browseCards(db, {}, T0 + 86_400_000).cards.map((card) => [card.id, card]),
    );
    expect(byId.get(due)).toMatchObject({ state: "due" });
    expect(byId.get(waiting)?.state).toBe("scheduled");
    expect(byId.get(waiting)?.dueAt).toBeGreaterThan(T0 + 86_400_000);
    expect(byId.get(idOf(db, "Unità della forza?"))).toMatchObject({
      state: "new",
      dueAt: null,
    });
    // Due now: new and overdue cards, not the one that waits.
    const dueNow = fronts(db, { status: "due" });
    expect(dueNow).toContain("Unità della forza?");
    expect(dueNow).not.toContain("Velocità media?");
  });

  it("uses the newest review when a card has several", () => {
    const db = library();
    const id = idOf(db, "Numero atomico?");
    rateCard(db, id, "easy", T0);
    const later = T0 + 40 * 86_400_000;
    rateCard(db, id, "again", later);
    const card = browseCards(db, { query: "atomico" }, later).cards[0]!;
    expect(card.dueAt).toBe(
      (
        JSON.parse(
          (
            db
              .prepare(
                `SELECT state_json FROM card_reviews WHERE card_id = ? ORDER BY reviewed_at DESC LIMIT 1`,
              )
              .get(id) as { state_json: string }
          ).state_json,
        ) as { dueAt: number }
      ).dueAt,
    );
  });

  it("pages the matches and counts every page's subject", () => {
    const db = library();
    const page = browseCards(db, { offset: 2, limit: 2 }, T0);
    expect(page.total).toBe(6);
    expect(page.cards.map((card) => card.front)).toEqual([
      "Unità della forza?",
      "Numero atomico?",
    ]);
    expect(page.groups.map((group) => group.count)).toEqual([3, 2, 1]);
    expect(browseCards(db, { offset: 50 }, T0).cards).toEqual([]);
  });

  it("keeps the review schedule when a card is edited", () => {
    const db = library();
    const id = idOf(db, "Numero atomico?");
    const state = rateCard(db, id, "good", T0);
    const before = db
      .prepare(`SELECT * FROM card_reviews WHERE card_id = ?`)
      .all(id);
    saveCard(db, {
      planId: "p-chem",
      topicId: "t-atoms",
      cardId: id,
      front: "Numero atomico (Z)?",
      back: "Protoni.",
    });
    expect(
      db.prepare(`SELECT * FROM card_reviews WHERE card_id = ?`).all(id),
    ).toEqual(before);
    const card = browseCards(db, { query: "(Z)" }, T0).cards[0]!;
    expect(card).toMatchObject({
      id,
      back: "Protoni.",
      state: "scheduled",
      dueAt: state.dueAt,
    });
  });

  it("does not let an edit move a card to another exam", () => {
    const db = library();
    const id = idOf(db, "Numero atomico?");
    expect(() =>
      saveCard(db, {
        planId: "p-phys",
        topicId: "t-dyn",
        cardId: id,
        front: "x",
        back: "y",
      }),
    ).toThrow("card-missing");
  });
});
