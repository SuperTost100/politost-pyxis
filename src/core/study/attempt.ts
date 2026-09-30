import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { gradeAnswer, type Grade } from "./grade";

export type QuizQuestion = {
  id: string;
  stem: string;
  grade: Grade;
};

type Stored = {
  questions: Array<{ id: string; stem: string; answer: Grade }>;
};

export function saveQuiz(
  db: Database.Database,
  planId: string,
  questions: QuizQuestion[],
  now = Date.now(),
): string {
  const id = uuidv7(now);
  const body: Stored = {
    questions: questions.map((question) => ({
      id: question.id,
      stem: question.stem,
      answer: question.grade,
    })),
  };
  db.prepare(
    `INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at)
     VALUES (?, ?, 'quiz', ?, 'sources', ?)`,
  ).run(id, planId, JSON.stringify(body), now);
  return id;
}

export function startAttempt(
  db: Database.Database,
  planId: string,
  itemId: string,
  now = Date.now(),
): { attemptId: string; questions: Array<{ id: string; stem: string; grade: { kind: Grade["kind"] } }> } {
  const item = db.prepare(`SELECT body_json FROM items WHERE id = ? AND plan_id = ?`).get(
    itemId,
    planId,
  ) as { body_json: string } | undefined;
  if (!item) throw new Error("quiz-missing");
  const stored = JSON.parse(item.body_json) as Stored;
  const attemptId = uuidv7(now);
  db.prepare(
    `INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES (?, ?, ?, ?)`,
  ).run(attemptId, planId, itemId, now);
  return {
    attemptId,
    questions: stored.questions.map((question) => ({
      id: question.id,
      stem: question.stem,
      grade: { kind: question.answer.kind },
    })),
  };
}

export function submitAttempt(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, unknown>,
  now = Date.now(),
): { score: number; results: Array<{ id: string; score: number }> } {
  const attempt = db
    .prepare(
      `SELECT a.id, a.submitted_at, i.body_json
       FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
    )
    .get(attemptId) as { id: string; submitted_at: number | null; body_json: string } | undefined;
  if (!attempt) throw new Error("attempt-missing");
  if (attempt.submitted_at != null) throw new Error("attempt-closed");
  const stored = JSON.parse(attempt.body_json) as Stored;
  const results = stored.questions.map((question) => ({
    id: question.id,
    score: gradeAnswer(answerOf(question.answer, picks[question.id])),
  }));
  const score =
    results.length === 0
      ? 0
      : results.reduce((sum, row) => sum + row.score, 0) / results.length;
  db.prepare(
    `INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
  ).run(uuidv7(now), attemptId, JSON.stringify({ picks, results, score }), now);
  db.prepare(`UPDATE attempts SET submitted_at = ? WHERE id = ?`).run(now, attemptId);
  return { score, results };
}

function answerOf(expected: Grade, pick: unknown): Grade {
  if (expected.kind === "mcq") {
    return { kind: "mcq", picked: Number(pick), correct: expected.correct };
  }
  if (expected.kind === "tf") {
    return { kind: "tf", picked: pick === true, correct: expected.correct };
  }
  if (expected.kind === "matching") {
    const pairs = Array.isArray(pick) ? (pick as Array<[string, string]>) : [];
    return { kind: "matching", pairs, correct: expected.correct };
  }
  const answers = Array.isArray(pick) ? (pick as string[]) : [];
  return { kind: "completion", answers, accepted: expected.accepted };
}
