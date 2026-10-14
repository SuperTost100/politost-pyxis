import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { appendEvent } from "../events";
import { saveQuiz, startAttempt, submitAttempt } from "../study/attempt";
import { planGuide } from "./create";
import { gradedActivities, readSteps, recordStep } from "./steps";

type Db = ReturnType<typeof openDatabase>;

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Physics', 'ready', 1, 1)",
  ).run();
  for (const [id, position] of [
    ["a", 0],
    ["b", 1],
  ] as const)
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'plan', ?, ?, 1)",
    ).run(id, `Topic ${id}`, position);
  return db;
}

function lesson(db: Db, id: string, topicId: string | null, at: number, kind = "lesson") {
  db.prepare(
    "INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, 'plan', ?, ?, '{}', ?)",
  ).run(id, topicId, kind, at);
}

/** A submitted quiz on one topic; `drill` links it to a gap as a gap drill. */
function quiz(db: Db, topicId: string, at: number, options: { drill?: boolean; kind?: string } = {}) {
  const itemId = saveQuiz(
    db,
    "plan",
    [{ id: `q${at}`, stem: "Pick", options: ["right", "wrong"], grade: { kind: "mcq", picked: -1, correct: 0 } }],
    at,
  );
  db.prepare("UPDATE items SET topic_id = ?, kind = ? WHERE id = ?").run(
    options.kind === "quiz" || !options.kind ? topicId : null,
    options.kind ?? "quiz",
    itemId,
  );
  if (options.drill) {
    db.prepare(
      "INSERT INTO gaps (id, plan_id, topic_id, opened_at, origin) VALUES (?, 'plan', ?, ?, 'answers')",
    ).run(`gap${at}`, topicId, at);
    db.prepare("INSERT INTO gap_items (gap_id, item_id) VALUES (?, ?)").run(`gap${at}`, itemId);
  }
  const { attemptId } = startAttempt(db, "plan", itemId, at);
  submitAttempt(db, attemptId, { [`q${at}`]: "1" }, at);
  return attemptId;
}

const answer = (db: Db, topicId: string, at: number, payload: Record<string, unknown>, itemId?: string) =>
  appendEvent(db, { kind: "answer_given", planId: "plan", topicId, itemId, payload, at });

describe("path steps", () => {
  it("names the lesson read and the attempt submitted, so the path can reopen them", () => {
    const db = fixture();
    lesson(db, "old-lesson", "a", 10);
    lesson(db, "new-lesson", "a", 20);
    lesson(db, "intro", null, 5, "intro");
    const attemptId = quiz(db, "a", 30);
    // Reading through plans.complete names the topic's newest lesson; a smart check names its own item.
    expect(recordStep(db, "plan", { activity: "intro", topicId: null }, 40)).toBe(true);
    expect(recordStep(db, "plan", { activity: "lesson", topicId: "a" }, 41)).toBe(true);
    expect(recordStep(db, "plan", { activity: "lesson", topicId: "b", itemId: "own" }, 42)).toBe(true);
    expect(recordStep(db, "plan", { activity: "quiz", topicId: "a", attemptId }, 43)).toBe(true);
    // Practice and cards have nothing to name; an attempt id passed with them is not kept.
    expect(recordStep(db, "plan", { activity: "practice", topicId: "a", attemptId }, 44)).toBe(true);
    expect(readSteps(db, "plan").map(({ activity, itemId, attemptId }) => [activity, itemId, attemptId])).toEqual([
      ["intro", "intro", null],
      ["lesson", "new-lesson", null],
      ["lesson", "own", null],
      ["quiz", null, attemptId],
      ["practice", null, null],
    ]);
    // Reopening a lesson records nothing new.
    expect(recordStep(db, "plan", { activity: "lesson", topicId: "a" }, 50)).toBe(false);
    db.close();
  });

  it("finds the attempt of an older step: the latest of its kind and topic submitted by the step's time", () => {
    const db = fixture();
    const first = quiz(db, "a", 10);
    const second = quiz(db, "a", 20);
    const later = quiz(db, "a", 100);
    const drill = quiz(db, "a", 25, { drill: true });
    const onB = quiz(db, "b", 26);
    const diagnostic = quiz(db, "a", 27, { kind: "diagnostic" });
    const older = (activity: string, topicId: string | null, at: number) =>
      appendEvent(db, { kind: "lesson_completed", planId: "plan", topicId, payload: { activity }, at });
    older("quiz", "a", 15);
    older("quiz", "a", 30);
    older("gaps", "a", 30);
    older("quiz", "b", 30);
    older("diagnostic", null, 30);
    older("quiz", "b", 5);
    older("lesson", "a", 31);
    expect(readSteps(db, "plan").map(({ activity, attemptId }) => [activity, attemptId])).toEqual([
      ["quiz", null],
      ["quiz", first],
      ["quiz", second],
      ["gaps", drill],
      ["quiz", onB],
      ["diagnostic", diagnostic],
      ["lesson", null],
    ]);
    expect(later).not.toBe(second);
    db.close();
  });
});

describe("gradedActivities", () => {
  it("counts each quiz, rated practice run, card run and quick check run after the lesson, not reading or bare practice", () => {
    const db = fixture();
    lesson(db, "lesson-a", "a", 1);
    // Quick checks answered while reading come before the lesson counts as read.
    answer(db, "a", 9, { score: 1, evidenceKind: "check", blockId: "x" }, "lesson-a");
    recordStep(db, "plan", { activity: "lesson", topicId: "a" }, 10);
    expect(gradedActivities(db, "plan", "a", 10)).toBe(0);
    // Exercises finished without a rating are no graded activity.
    recordStep(db, "plan", { activity: "practice", topicId: "a" }, 20);
    expect(gradedActivities(db, "plan", "a", 10)).toBe(0);
    // Two ratings and a changed mind in one sitting are one activity.
    answer(db, "a", 30, { score: 1, evidenceKind: "self", exerciseId: "e1" });
    answer(db, "a", 31, { score: 0, evidenceKind: "self", exerciseId: "e1" });
    answer(db, "a", 32, { score: 1, evidenceKind: "self", exerciseId: "e2" });
    recordStep(db, "plan", { activity: "practice", topicId: "a" }, 33);
    expect(gradedActivities(db, "plan", "a", 10)).toBe(1);
    // A second session after "Mark as done" is another.
    answer(db, "a", 40, { score: 0, evidenceKind: "self", exerciseId: "e1" });
    expect(gradedActivities(db, "plan", "a", 10)).toBe(2);
    // A quiz attempt is one, whatever its length; a diagnostic or simulation's share of the topic is one too.
    answer(db, "a", 50, { score: 0.2, scores: [0, 0, 1, 0, 0], attemptId: "attempt-1" });
    recordStep(db, "plan", { activity: "quiz", topicId: "a", attemptId: "attempt-1" }, 51);
    answer(db, "a", 52, { score: 1, evidenceKind: "simulation", attemptId: "attempt-2" });
    expect(gradedActivities(db, "plan", "a", 10)).toBe(4);
    // A run of card ratings is one review session.
    for (const at of [60, 61, 62])
      appendEvent(db, { kind: "card_rated", planId: "plan", topicId: "a", payload: { score: 1, cardId: `c${at}` }, at });
    expect(gradedActivities(db, "plan", "a", 10)).toBe(5);
    // Quick checks answered on a second visit to the lesson are one.
    answer(db, "a", 70, { score: 1, evidenceKind: "check", blockId: "y" }, "lesson-a");
    answer(db, "a", 71, { score: 0, evidenceKind: "check", blockId: "z" }, "lesson-a");
    expect(gradedActivities(db, "plan", "a", 10)).toBe(6);
    // Another topic's work never counts here.
    answer(db, "b", 80, { score: 1, attemptId: "attempt-3" });
    expect(gradedActivities(db, "plan", "a", 10)).toBe(6);
    expect(gradedActivities(db, "plan", "b", 10)).toBe(1);
    db.close();
  });

  it("lets planGuide keep a missed topic for three activities, then move to the next chapter", () => {
    const db = fixture();
    const day = 86_400_000;
    const start = Date.now() - day;
    recordStep(db, "plan", { activity: "lesson", topicId: "a" }, start);
    const next = (at: number) => planGuide(db, "plan", at)!.next;
    expect(next(start + 1)).toMatchObject({ activity: "practice", topicId: "a", reason: "consolidate" });
    answer(db, "a", start + 10, { score: 0, evidenceKind: "self", exerciseId: "e1" });
    recordStep(db, "plan", { activity: "practice", topicId: "a" }, start + 11);
    expect(next(start + 12)).toMatchObject({ activity: "quiz", topicId: "a", reason: "check" });
    const missed = quiz(db, "a", start + 20);
    answer(db, "a", start + 20, { score: 0, scores: [0], attemptId: missed });
    recordStep(db, "plan", { activity: "quiz", topicId: "a", attemptId: missed }, start + 21);
    expect(next(start + 22)).toMatchObject({ activity: "practice", topicId: "a", reason: "stay" });
    answer(db, "a", start + 30, { score: 0, evidenceKind: "self", exerciseId: "e1" });
    recordStep(db, "plan", { activity: "practice", topicId: "a" }, start + 31);
    expect(next(start + 32)).toMatchObject({ activity: "lesson", topicId: "b", reason: "next" });
    // A week later the topic, still below the target, comes back for a review before the next chapter.
    expect(next(start + 9 * day)).toMatchObject({ activity: "quiz", topicId: "a", reason: "review" });
    db.close();
  });
});
