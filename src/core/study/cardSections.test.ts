import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { dueEverywhere, todayPlan } from "../plans/planner";
import { browseCards } from "./cardBrowser";
import { cardSections } from "./cardSections";
import { deckDueCards, rateCard, setNewCardsPerDay } from "./cards";

const NOW = Date.UTC(2026, 10, 10, 10, 0, 0);
const DAY = 86_400_000;

type Db = ReturnType<typeof openDatabase>;

function subject(db: Db, id: string, name: string, position: number) {
  db.prepare(`INSERT INTO subjects (id, name, position, created_at) VALUES (?, ?, ?, 1)`).run(id, name, position);
}

function plan(db: Db, id: string, title: string, subjectId: string | null, examAt: number | null = null) {
  db.prepare(
    `INSERT INTO plans (id, subject_id, title, status, exam_at, created_at, updated_at)
     VALUES (?, ?, ?, 'ready', ?, 1, 1)`,
  ).run(id, subjectId, title, examAt);
}

function topic(db: Db, id: string, planId: string, title: string, position: number) {
  db.prepare(`INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, ?, ?, 1)`).run(
    id,
    planId,
    title,
    position,
  );
}

let made = 0;
/** `count` new cards in a topic of an exam, or under a subject with no exam when `topicId` is null. */
function cards(db: Db, count: number, at: { planId: string; topicId: string } | { subjectId: string }) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    made += 1;
    const id = `c${made}`;
    ids.push(id);
    if ("planId" in at)
      db.prepare(`INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES (?, ?, ?, ?, 'b', ?)`).run(
        id,
        at.planId,
        at.topicId,
        `front ${id}`,
        made,
      );
    else
      db.prepare(`INSERT INTO cards (id, subject_id, front, back, created_at) VALUES (?, ?, ?, 'b', ?)`).run(
        id,
        at.subjectId,
        `front ${id}`,
        made,
      );
  }
  return ids;
}

/** Goes through a review to its end the way the review page does: rate what it shows, ask again, until it is empty. */
function drain(db: Db, next: () => Array<{ id: string }>): number {
  let rated = 0;
  for (let shown = next(); shown.length > 0; shown = next()) {
    for (const card of shown) rateCard(db, card.id, "good", NOW);
    rated += shown.length;
    if (rated > 10_000) throw new Error("the review never ended");
  }
  return rated;
}

/**
 * Analisi 1 with a dated exam (two topics) and cards with no exam; Fisica 2 with cards with no exam only; an exam with
 * no subject; and cards an archived exam, an archived topic or a removed card should keep out.
 */
function workspace() {
  const db = openDatabase(":memory:");
  subject(db, "s-fis", "Fisica 2", 1);
  subject(db, "s-ana", "Analisi 1", 0);
  subject(db, "s-gal", "Geometria", 2);
  plan(db, "p-ana", "Appello del 14 gennaio", "s-ana", NOW + 30 * DAY);
  topic(db, "t-lim", "p-ana", "Limiti", 1);
  topic(db, "t-num", "p-ana", "Numeri reali", 0);
  cards(db, 3, { planId: "p-ana", topicId: "t-lim" });
  cards(db, 2, { planId: "p-ana", topicId: "t-num" });
  cards(db, 4, { subjectId: "s-ana" });
  cards(db, 2, { subjectId: "s-fis" });
  plan(db, "p-old", "Appunti", null);
  topic(db, "t-old", "p-old", "Varie", 0);
  cards(db, 1, { planId: "p-old", topicId: "t-old" });
  plan(db, "p-arch", "Vecchio appello", "s-gal");
  topic(db, "t-arch", "p-arch", "Spazi vettoriali", 0);
  cards(db, 5, { planId: "p-arch", topicId: "t-arch" });
  db.prepare("UPDATE plans SET archived_at = 1 WHERE id = 'p-arch'").run();
  topic(db, "t-gone", "p-ana", "Argomento archiviato", 2);
  cards(db, 2, { planId: "p-ana", topicId: "t-gone" });
  db.prepare("UPDATE topics SET archived_at = 1 WHERE id = 't-gone'").run();
  const [removed] = cards(db, 1, { subjectId: "s-fis" });
  db.prepare("UPDATE cards SET removed = 1 WHERE id = ?").run(removed);
  return db;
}

describe("cardSections", () => {
  it("groups by subject, exam and topic, the cards with no exam last in each subject and no subject last", () => {
    const db = workspace();
    const page = cardSections(db, NOW);
    expect(
      page.subjects.map((subject) => ({
        name: subject.name,
        total: subject.total,
        exams: subject.exams.map((exam) => [exam.title, exam.total, exam.topics.map((topic) => topic.title)]),
        examless: subject.examless?.total ?? null,
      })),
    ).toEqual([
      {
        name: "Analisi 1",
        total: 9,
        exams: [["Appello del 14 gennaio", 5, ["Numeri reali", "Limiti"]]],
        examless: 4,
      },
      { name: "Fisica 2", total: 2, exams: [], examless: 2 },
      { name: null, total: 1, exams: [["Appunti", 1, ["Varie"]]], examless: null },
    ]);
    expect(page.total).toBe(12);
    // Every card here is new and due, under the daily limit.
    expect(page.subjects.map((subject) => subject.due)).toEqual([9, 2, 1]);
    expect(page.due).toBe(12);
  });

  it("counts the same cards as the card browser shows under all", () => {
    const db = workspace();
    const browsed = browseCards(db, {}, NOW);
    const page = cardSections(db, NOW);
    expect(page.subjects.map((subject) => [subject.subjectId, subject.total])).toEqual(
      browsed.groups.map((group) => [group.subjectId, group.count]),
    );
  });

  it("totals what the daily review goes through, past the 20 a time and the daily limit of new cards", () => {
    const db = workspace();
    // 24 more new cards in one topic: the review shows 20 at a time, and the exam's daily limit stops new ones at 20.
    cards(db, 24, { planId: "p-ana", topicId: "t-num" });
    // An undated exam and a past one are in the review too.
    plan(db, "p-past", "Appello di settembre", "s-fis", NOW - 40 * DAY);
    topic(db, "t-past", "p-past", "Campo elettrico", 0);
    cards(db, 3, { planId: "p-past", topicId: "t-past" });
    // Suspended cards count among the subject's flashcards but are never due.
    db.prepare("UPDATE cards SET suspended = 1 WHERE id IN (SELECT id FROM cards WHERE subject_id = 's-fis' LIMIT 1)").run();
    // Some cards were rated already today, and one is due again.
    const { id: rated } = db.prepare("SELECT id FROM cards WHERE topic_id = 't-lim' LIMIT 1").get() as { id: string };
    rateCard(db, rated, "again", NOW - 3_600_000);
    const page = cardSections(db, NOW);
    expect(page.due).toBe(todayPlan(db, NOW).cards?.due);
    const subjectsDue = page.subjects.map((subject) => subject.due);

    expect(drain(db, () => dueEverywhere(db, NOW))).toBe(page.due);
    expect(subjectsDue.reduce((sum, due) => sum + due, 0)).toBe(page.due);
    expect(cardSections(db, NOW).due).toBe(0);
  });

  it("gives each subject's review and each no-exam row the count it shows", () => {
    const db = workspace();
    cards(db, 24, { planId: "p-ana", topicId: "t-num" });
    setNewCardsPerDay(db, 5, NOW);
    const page = cardSections(db, NOW);
    const ana = page.subjects.find((subject) => subject.subjectId === "s-ana")!;
    const none = page.subjects.find((subject) => subject.subjectId === null)!;
    // The exam's 5 new cards a day, and 4 of the subject's own (their deck has a limit of 5 too).
    expect(ana.due).toBe(9);
    expect(ana.examless?.due).toBe(4);
    // A topic fills the exam's allowance with its own new cards, as it does when opened from the exam's page.
    expect(ana.exams[0]!.topics.map((topic) => topic.due)).toEqual([5, 3]);

    expect(drain(db, () => deckDueCards(db, { subjectId: "s-ana" }, NOW))).toBe(4);
    expect(drain(db, () => dueEverywhere(db, NOW, { subjectId: "s-ana" }))).toBe(5);
    expect(drain(db, () => dueEverywhere(db, NOW, { subjectId: null }))).toBe(none.due);
    expect(cardSections(db, NOW).subjects.map((subject) => subject.due)).toEqual([0, 2, 0]);
  });

  it("gives an exam's cards with no topic a row of their own, so the rows add up to the subject's count", () => {
    const db = workspace();
    db.prepare(`INSERT INTO cards (id, plan_id, front, back, created_at) VALUES ('loose', 'p-ana', 'Senza argomento', 'b', 999)`).run();
    // A topic deleted later leaves its cards with no topic.
    topic(db, "t-del", "p-ana", "Argomento cancellato", 3);
    cards(db, 1, { planId: "p-ana", topicId: "t-del" });
    db.prepare("DELETE FROM topics WHERE id = 't-del'").run();
    const ana = cardSections(db, NOW).subjects.find((subject) => subject.subjectId === "s-ana")!;
    const exam = ana.exams[0]!;
    expect(exam.noTopic).toEqual({ total: 2, due: 2 });
    const rows = [
      ...exam.topics.map((topic) => topic.total),
      exam.noTopic?.total ?? 0,
      ana.examless?.total ?? 0,
    ];
    expect(rows.reduce((sum, count) => sum + count, 0)).toBe(ana.total);
    // The row's review holds exactly the cards it counts.
    expect(drain(db, () => dueEverywhere(db, NOW, { planId: "p-ana", noTopic: true }))).toBe(2);
    expect(cardSections(db, NOW).subjects[0]!.exams[0]!.noTopic).toEqual({ total: 2, due: 0 });
    // An exam whose cards all have a topic has no such row.
    expect(cardSections(db, NOW).subjects.at(-1)!.exams[0]!.noTopic).toBeNull();
  });

  it("serves a workspace with flashcards and no exam at all", () => {
    const db = openDatabase(":memory:");
    subject(db, "s-chem", "Chimica", 0);
    cards(db, 3, { subjectId: "s-chem" });
    const page = cardSections(db, NOW);
    expect(page).toEqual({
      due: 3,
      total: 3,
      subjects: [
        { subjectId: "s-chem", name: "Chimica", total: 3, due: 3, exams: [], examless: { total: 3, due: 3 } },
      ],
    });
    expect(drain(db, () => dueEverywhere(db, NOW))).toBe(3);
  });

  it("is empty with no flashcards, and leaves out an exam still being built", () => {
    const db = openDatabase(":memory:");
    expect(cardSections(db, NOW)).toEqual({ due: 0, total: 0, subjects: [] });
    plan(db, "p-new", "Fisica 1", null);
    topic(db, "t-new", "p-new", "Dinamica", 0);
    cards(db, 2, { planId: "p-new", topicId: "t-new" });
    db.prepare("UPDATE plans SET status = 'building' WHERE id = 'p-new'").run();
    expect(cardSections(db, NOW)).toEqual({ due: 0, total: 0, subjects: [] });
    expect(dueEverywhere(db, NOW)).toEqual([]);
  });
});
