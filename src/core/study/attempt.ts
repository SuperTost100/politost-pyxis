import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { gradeAnswer, type Grade } from "./grade";

export type QuizQuestion = {
  id: string;
  sourceId?: string;
  sourceIds?: string[];
  stem: string;
  explanation?: string;
  options?: string[];
  left?: string[];
  right?: string[];
  grade: Grade;
};

export type StoredQuestion = {
  id: string;
  sourceId?: string;
  sourceIds?: string[];
  stem: string;
  explanation?: string;
  options?: string[];
  left?: string[];
  right?: string[];
  answer: Grade;
};

type Stored = {
  questions: StoredQuestion[];
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
      sourceId: question.sourceId,
      sourceIds: question.sourceIds,
      stem: question.stem,
      explanation: question.explanation,
      options: question.options,
      left: question.left,
      right: question.right,
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
): {
  attemptId: string;
  questions: Array<{
    id: string;
    sourceId?: string;
    stem: string;
    options?: string[];
    left?: string[];
    right?: string[];
    grade: { kind: Grade["kind"] };
  }>;
} {
  const item = db
    .prepare(`SELECT body_json FROM items WHERE id = ? AND plan_id = ?`)
    .get(itemId, planId) as { body_json: string } | undefined;
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
      sourceId: question.sourceId,
      stem: question.stem,
      options: question.options,
      left: question.left,
      right: question.right,
      grade: { kind: question.answer.kind },
    })),
  };
}

export function submitAttempt(
  db: Database.Database,
  attemptId: string,
  picks: Record<string, unknown>,
  now = Date.now(),
  graded?: Map<
    string,
    { score: number; expected: string; explanation: string }
  >,
): {
  score: number;
  results: Array<{
    id: string;
    score: number;
    expected: string;
    explanation: string;
  }>;
} {
  const attempt = db
    .prepare(
      `SELECT a.id, a.submitted_at, i.body_json
       FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?`,
    )
    .get(attemptId) as
    { id: string; submitted_at: number | null; body_json: string } | undefined;
  if (!attempt) throw new Error("attempt-missing");
  if (attempt.submitted_at != null) throw new Error("attempt-closed");
  const stored = JSON.parse(attempt.body_json) as Stored;
  const results = stored.questions.map((question) => ({
    id: question.id,
    score:
      graded?.get(question.id)?.score ??
      gradeAnswer(answerOf(question.answer, picks[question.id])),
    expected: graded?.get(question.id)?.expected ?? expectedText(question),
    explanation:
      graded?.get(question.id)?.explanation ?? question.explanation ?? "",
  }));
  const score =
    results.length === 0
      ? 0
      : results.reduce((sum, row) => sum + row.score, 0) / results.length;
  db.prepare(
    `INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
  ).run(uuidv7(now), attemptId, JSON.stringify({ picks, results, score }), now);
  db.prepare(`UPDATE attempts SET submitted_at = ? WHERE id = ?`).run(
    now,
    attemptId,
  );
  return { score, results };
}

export function expectedText(question: StoredQuestion): string {
  const answer = question.answer;
  if (answer.kind === "mcq") return question.options?.[answer.correct] ?? "";
  if (answer.kind === "tf") return answer.correct ? "true" : "false";
  if (answer.kind === "matching")
    return answer.correct.map((pair) => pair.join(" = ")).join("; ");
  if (answer.kind === "open") return answer.reference;
  return answer.accepted[0]?.[0] ?? "";
}

function readPairs(pick: unknown): Array<[string, string]> {
  const list = Array.isArray(pick)
    ? pick
    : typeof pick === "string"
      ? parsedPairs(pick)
      : [];
  return list.flatMap((item) =>
    Array.isArray(item) &&
    typeof item[0] === "string" &&
    typeof item[1] === "string"
      ? [[item[0], item[1]] as [string, string]]
      : [],
  );
}

function parsedPairs(pick: string): unknown[] {
  try {
    const parsed = JSON.parse(pick) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function answerOf(expected: Grade, pick: unknown): Grade {
  if (expected.kind === "mcq") {
    const text = typeof pick === "number" ? String(pick) : pick;
    const picked =
      typeof text === "string" &&
      text.trim() !== "" &&
      Number.isInteger(Number(text))
        ? Number(text)
        : -1;
    return { kind: "mcq", picked, correct: expected.correct };
  }
  if (expected.kind === "tf") {
    const answered =
      pick === true || pick === "true" || pick === false || pick === "false";
    const picked = pick === true || pick === "true";
    return {
      kind: "tf",
      picked: answered ? picked : !expected.correct,
      correct: expected.correct,
    };
  }
  if (expected.kind === "matching") {
    const pairs = readPairs(pick);
    return { kind: "matching", pairs, correct: expected.correct };
  }
  if (expected.kind === "open") {
    return {
      kind: "open",
      answer: typeof pick === "string" ? pick : "",
      reference: expected.reference,
    };
  }
  const answers = Array.isArray(pick)
    ? (pick as string[])
    : typeof pick === "string"
      ? completionAnswers(pick)
      : [];
  return { kind: "completion", answers, accepted: expected.accepted };
}

function completionAnswers(pick: string): string[] {
  try {
    const parsed: unknown = JSON.parse(pick);
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === "string")
    )
      return parsed;
  } catch {
    /* Plain single-blank answers remain supported. */
  }
  return [pick];
}
