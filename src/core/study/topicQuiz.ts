import type Database from "better-sqlite3";
import { completeNode } from "../plans/create";
import {
  QUIZ_MAX_QUESTIONS,
  questionFlagged,
  saveQuiz,
  startAttempt,
  submitAttempt,
  type StoredQuestion,
} from "./attempt";
import { mixQuestions } from "./mix";
import { topicExercises } from "./exercises";
import { flaggedIds } from "./flags";
import { requireTopic } from "./openLesson";
import { uuidv7 } from "../../shared/ids";
import { quizMinutes } from "../../shared/quiz";

/** Free answers are model-graded at submit; exact text must not decide credit. */
function openGrade(reference: string) {
  return { kind: "open" as const, answer: "", reference };
}

export function acrossTopics<T>(buckets: T[][], limit: number): T[] {
  const picked: T[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let added = false;
    for (const bucket of buckets) {
      const row = bucket[round];
      if (!row) continue;
      picked.push(row);
      added = true;
      if (picked.length === limit) break;
    }
    if (!added) break;
  }
  return picked;
}

/** Most recent unsubmitted diagnostic attempt of this plan, so a reload resumes instead of duplicating it. */
function openDiagnostic(db: Database.Database, planId: string) {
  const row = db
    .prepare(
      `SELECT a.id, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id
       WHERE a.plan_id = ? AND i.plan_id = ? AND i.kind = 'diagnostic' AND a.submitted_at IS NULL
       ORDER BY a.started_at DESC, a.id DESC LIMIT 1`,
    )
    .get(planId, planId) as { id: string; body_json: string } | undefined;
  if (!row) return undefined;
  const stored = JSON.parse(row.body_json) as {
    questions: Array<{
      id: string;
      sourceId?: string;
      stem: string;
      options?: string[];
      left?: string[];
      right?: string[];
      answer: { kind: "mcq" | "tf" | "completion" | "matching" | "open" };
    }>;
  };
  return {
    attemptId: row.id,
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

/** What the diagnostic intro tells before anything starts: how many questions, how long, and how many are done. */
export function diagnosticPreview(db: Database.Database, planId: string) {
  const open = openDiagnostic(db, planId);
  if (open && open.questions.length <= QUIZ_MAX_QUESTIONS) {
    const { n } = db
      .prepare(
        "SELECT count(*) AS n FROM attempt_answers WHERE attempt_id = ? AND json_type(payload_json, '$.check') = 'object'",
      )
      .get(open.attemptId) as { n: number };
    return {
      count: open.questions.length,
      answered: n,
      minutes: quizMinutes(open.questions.map((row) => row.grade.kind)),
    };
  }
  const generated = latestGeneratedDiagnostic(db, planId);
  const blocked = flaggedIds(db, "exercise");
  const kinds = generated
    ? (JSON.parse(generated.body_json) as { questions: StoredQuestion[] }).questions
        .filter((question) => !questionFlagged(blocked, question))
        .map((question) => question.answer.kind)
    : (
        db
          .prepare(`SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL`)
          .all(planId) as Array<{ id: string }>
      ).flatMap((topic) =>
        topicExercises(db, topic.id)
          .filter((row) => row.answer?.trim() && !blocked.has(row.id))
          .map(() => "open"),
      );
  const picked = kinds.slice(0, QUIZ_MAX_QUESTIONS);
  return {
    count: picked.length,
    answered: 0,
    minutes: picked.length ? quizMinutes(picked) : 0,
  };
}

export function startDiagnostic(db: Database.Database, planId: string) {
  if (
    (
      db.prepare("SELECT status FROM plans WHERE id = ?").get(planId) as
        { status: string } | undefined
    )?.status === "building"
  )
    throw new Error("plan-building");
  const resumed = openDiagnostic(db, planId);
  // An open diagnostic from before the question limit is left behind; a fresh, shorter one starts.
  if (resumed && resumed.questions.length <= QUIZ_MAX_QUESTIONS) return resumed;
  const generated = latestGeneratedDiagnostic(db, planId);
  if (generated) return startAttempt(db, planId, usableDiagnostic(db, generated));
  const topics = db
    .prepare(`SELECT id FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position`)
    .all(planId) as Array<{ id: string }>;
  const blocked = flaggedIds(db, "exercise");
  const questions = acrossTopics(
    topics.map((topic) =>
      topicExercises(db, topic.id)
        .filter((row) => row.answer && row.answer.trim() && !blocked.has(row.id))
        .map((row) => ({
          id: row.id,
          topicId: topic.id,
          stem: row.prompt,
          grade: openGrade(row.answer ?? ""),
        })),
    ),
    QUIZ_MAX_QUESTIONS,
  );
  if (questions.length === 0) {
    const node = db
      .prepare(
        `SELECT id FROM path_nodes WHERE plan_id = ? AND kind = 'diagnostic'`,
      )
      .get(planId) as { id: string } | undefined;
    if (node) {
      try {
        completeNode(db, planId, node.id);
      } catch (err) {
        if (!(err instanceof Error) || err.message !== "node-locked") throw err;
      }
    }
    return { attemptId: "", questions: [] };
  }
  const itemId = saveQuiz(
    db,
    planId,
    questions.map((row) => ({ id: row.id, stem: row.stem, grade: row.grade })),
  );
  const stored = JSON.parse(
    (
      db.prepare(`SELECT body_json FROM items WHERE id = ?`).get(itemId) as {
        body_json: string;
      }
    ).body_json,
  ) as { questions: Array<{ id: string; topicId?: string }> };
  stored.questions.forEach((question, index) => {
    question.topicId = questions[index]?.topicId;
  });
  db.prepare(
    `UPDATE items SET kind = 'diagnostic', body_json = ? WHERE id = ?`,
  ).run(JSON.stringify(stored), itemId);
  return startAttempt(db, planId, itemId);
}

export function latestGeneratedDiagnostic(
  db: Database.Database,
  planId: string,
) {
  return db
    .prepare(
      "SELECT id, body_json FROM items WHERE plan_id = ? AND kind = 'diagnostic' AND engine_provider IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(planId) as { id: string; body_json: string } | undefined;
}

/**
 * Writes a newer copy of a model-written diagnostic with a new question list. Earlier attempts keep the item they
 * were taken on, so their results still find every question they asked.
 */
export function deriveDiagnostic(
  db: Database.Database,
  itemId: string,
  questions: StoredQuestion[],
  now = Date.now(),
): string {
  const row = db.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as Record<
    string,
    unknown
  > & { body_json: string; created_at: number };
  const id = uuidv7(now);
  const body = { ...(JSON.parse(row.body_json) as object), questions };
  db.prepare(
    `INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, created_at)
     SELECT ?, plan_id, topic_id, kind, ?, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, ? FROM items WHERE id = ?`,
  ).run(id, JSON.stringify(body), Math.max(now, row.created_at + 1), itemId);
  db.prepare(
    "INSERT OR IGNORE INTO item_passages (item_id, passage_id) SELECT ?, passage_id FROM item_passages WHERE item_id = ?",
  ).run(id, itemId);
  return id;
}

/** The diagnostic a new attempt uses: without questions marked wrong, and at most QUIZ_MAX_QUESTIONS spread across topics. */
function usableDiagnostic(
  db: Database.Database,
  item: { id: string; body_json: string },
): string {
  const stored = (JSON.parse(item.body_json) as { questions: StoredQuestion[] })
    .questions;
  const blocked = flaggedIds(db, "exercise");
  const kept = stored.filter((question) => !questionFlagged(blocked, question));
  const topics = [...new Set(kept.map((question) => question.topicId))];
  const picked = acrossTopics(
    topics.map((topicId) => kept.filter((question) => question.topicId === topicId)),
    QUIZ_MAX_QUESTIONS,
  );
  if (picked.length === stored.length || picked.length === 0) return item.id;
  // Keep the model's order for the questions that stay.
  const order = new Set(picked.map((question) => question.id));
  return deriveDiagnostic(
    db,
    item.id,
    stored.filter((question) => order.has(question.id)),
  );
}

export function startTopicQuiz(
  db: Database.Database,
  planId: string,
  topicId: string,
) {
  requireTopic(db, planId, topicId);
  const blocked = flaggedIds(db, "exercise");
  const exercises = topicExercises(db, topicId).filter(
    (row) => row.answer && row.answer.trim() && !blocked.has(row.id),
  );
  if (exercises.length === 0) throw new Error("quiz-empty");
  const mixed = mixQuestions(
    exercises.map((row) => ({
      id: row.id,
      prompt: row.prompt,
      answer: row.answer ?? "",
    })),
    QUIZ_MAX_QUESTIONS,
  );
  const itemId = saveQuiz(
    db,
    planId,
    mixed.length > 0
      ? mixed.map((row) =>
          row.grade.kind === "completion"
            ? { ...row, grade: openGrade(row.grade.accepted[0]?.[0] ?? "") }
            : row,
        )
      : exercises.slice(0, QUIZ_MAX_QUESTIONS).map((row) => ({
          id: row.id,
          stem: row.prompt,
          explanation: row.answer ?? "",
          grade: openGrade(row.answer ?? ""),
        })),
  );
  db.prepare(`UPDATE items SET topic_id = ? WHERE id = ?`).run(topicId, itemId);
  return startAttempt(db, planId, itemId);
}

export { submitAttempt };
