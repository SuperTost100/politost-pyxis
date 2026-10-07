import type Database from "better-sqlite3";
import { readSteps, recordStep } from "../plans/steps";
import { saveQuiz, startAttempt, submitAttempt } from "./attempt";
import { mixQuestions } from "./mix";
import { topicExercises } from "./exercises";
import { flaggedIds } from "./flags";
import { requireTopic } from "./openLesson";

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

export function startDiagnostic(db: Database.Database, planId: string) {
  if (
    (
      db.prepare("SELECT status FROM plans WHERE id = ?").get(planId) as
        { status: string } | undefined
    )?.status === "building"
  )
    throw new Error("plan-building");
  const resumed = openDiagnostic(db, planId);
  if (resumed) return resumed;
  const generated = db
    .prepare(
      "SELECT id FROM items WHERE plan_id = ? AND kind = 'diagnostic' AND engine_provider IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(planId) as { id: string } | undefined;
  if (generated) return startAttempt(db, planId, generated.id);
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
    20,
  );
  if (questions.length === 0) {
    // Nothing to ask: the diagnostic counts as done once, so it is not suggested again.
    if (!readSteps(db, planId).some((step) => step.activity === "diagnostic"))
      recordStep(db, planId, { activity: "diagnostic" });
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
      : exercises.slice(0, 20).map((row) => ({
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
