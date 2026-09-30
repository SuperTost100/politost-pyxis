import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { saveQuiz, startAttempt, submitAttempt } from "./attempt";

function plan(db: ReturnType<typeof openDatabase>) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Fisica', 'ready', 1, 1)`,
  ).run(id);
  return id;
}

describe("attempts", () => {
  it("hides the answer until submit and then scores the quiz", () => {
    const db = openDatabase(":memory:");
    const planId = plan(db);
    const itemId = saveQuiz(db, planId, [
      {
        id: "q1",
        stem: "Unita della forza?",
        grade: { kind: "mcq", picked: 0, correct: 1 },
      },
      {
        id: "q2",
        stem: "La velocita e uno scalare.",
        grade: { kind: "tf", picked: false, correct: false },
      },
    ]);
    const started = startAttempt(db, planId, itemId);
    expect(JSON.stringify(started.questions)).not.toContain("correct");
    const scored = submitAttempt(db, started.attemptId, { q1: 1, q2: false });
    expect(scored.score).toBe(1);
    const typed = saveQuiz(db, planId, [
      {
        id: "q3",
        stem: "Unita?",
        grade: { kind: "completion", answers: [], accepted: [["newton"]] },
      },
    ]);
    const typedAttempt = startAttempt(db, planId, typed);
    expect(submitAttempt(db, typedAttempt.attemptId, { q3: "Newton" }).score).toBe(1);
    expect(() => submitAttempt(db, started.attemptId, { q1: 1 })).toThrow(/attempt-closed/);
  });
});
