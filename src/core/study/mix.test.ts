import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { recordStep } from "../plans/steps";
import { syncGaps } from "../plans/progress";
import { importSmartbook } from "../sources/smartbook";
import { flagTarget } from "./flags";
import { mixQuestions } from "./mix";
import { writeLesson } from "./openLesson";
import { readQuiz, saveQuizDraft } from "./quizJobs";
import { startReview } from "./review";
import { startTopicQuiz, submitAttempt } from "./topicQuiz";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

/** Review draws new items from the path's frontier: the topic whose lesson the student read last. */
function reachFrontier(db: ReturnType<typeof openDatabase>, planId: string) {
  const first = db
    .prepare("SELECT id FROM topics WHERE plan_id = ? ORDER BY position LIMIT 1")
    .get(planId) as { id: string };
  recordStep(db, planId, { activity: "lesson", topicId: first.id });
}

const book = {
  "smartbook.json": JSON.stringify({
    id: "demo",
    title: "Fisica",
    access: "public",
    chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
  }),
  "chapters/01.md": "## p1 | Energia\nIl vettore sposta il punto.\n",
  "esercizi.md": ["forza", "energia", "lavoro", "potenza"]
    .map(
      (name, index) =>
        `:::exercise{id="e${index}" chapter="1"}\nChe cos'è ${name}?\n:::solution\n${name}\n:::\n:::\n`,
    )
    .join("\n"),
};

describe("mixed quiz", () => {
  it("uses every closed type and grades a true or false item", () => {
    const questions = mixQuestions(
      ["forza", "energia", "lavoro", "potenza"].map((name, index) => ({
        id: `e${index}`,
        prompt: `Che cos'è ${name}?`,
        answer: name,
      })),
    );
    const kinds = new Set(questions.map((question) => question.grade.kind));
    expect(kinds.has("mcq")).toBe(true);
    expect(kinds.has("tf")).toBe(true);
    expect(kinds.has("completion")).toBe(true);
    expect(kinds.has("matching")).toBe(true);
    expect(kinds.has("open")).toBe(true);

    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(book));
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as {
      id: string;
    };
    const started = startTopicQuiz(db, plan.planId, topic.id);
    const tf = started.questions.find(
      (question) => question.grade.kind === "tf",
    );
    expect(tf).toBeTruthy();
    const scored = submitAttempt(db, started.attemptId, {
      [tf?.id ?? ""]: "true",
    });
    expect(scored.results.find((row) => row.id === tf?.id)?.score).toBeTypeOf(
      "number",
    );
    flagTarget(db, "exercise", tf?.sourceId ?? "");
    syncGaps(db, plan.planId);
    const gaps = db
      .prepare(
        `SELECT COUNT(*) AS n FROM gaps WHERE plan_id = ? AND closed_at IS NULL`,
      )
      .get(plan.planId) as { n: number };
    expect(gaps.n).toBe(1);
    const other = createPlan(db, { title: "Altro", sourceIds: [] });
    expect(() => startTopicQuiz(db, other.planId, topic.id)).toThrow(
      /topic-missing/,
    );
    const blank = startTopicQuiz(db, plan.planId, topic.id);
    const blankScore = submitAttempt(db, blank.attemptId, {});
    expect(blankScore.results.every((row) => row.score === 0)).toBe(true);
    expect(() => startTopicQuiz(db, plan.planId, topic.id)).not.toThrow();
  });

  it("stores a model lesson and builds a review from the book", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(book));
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as {
      id: string;
    };
    const lesson = await writeLesson(db, plan.planId, topic.id, async () => ({
      text: "La forza cambia il moto [P1].",
      model: "fixture",
      provider: "fixture",
      inputTokens: 1,
    }));
    expect(lesson.markdown).toContain("[P1]");
    reachFrontier(db, plan.planId);
    const again = await writeLesson(db, plan.planId, topic.id, async () => ({
      text: "seconda",
      model: "fixture",
      provider: "fixture",
      inputTokens: 1,
    }));
    expect(again.markdown).toBe(lesson.markdown);
    const review = startReview(db, plan.planId);
    expect(review.questions.length).toBeGreaterThan(0);
    const first = new Set(
      review.questions.flatMap((question) =>
        question.sourceId ? [question.sourceId] : [],
      ),
    );
    const stored = db
      .prepare(
        `SELECT body_json FROM items WHERE plan_id = ? AND kind = 'review'`,
      )
      .all(plan.planId) as Array<{ body_json: string }>;
    const remembered = stored.flatMap((row) => {
      const body = JSON.parse(row.body_json) as {
        questions?: Array<{ sourceIds?: string[] }>;
      };
      return (body.questions ?? []).flatMap(
        (question) => question.sourceIds ?? [],
      );
    });
    expect(remembered.length).toBeGreaterThan(1);
    // An unfinished review is resumed as it was; only a finished one makes room for new items.
    expect(startReview(db, plan.planId).sessionId).toBe(review.sessionId);
    submitAttempt(db, review.attemptId, {});
    const nextReview = startReview(db, plan.planId);
    expect(nextReview.sessionId).not.toBe(review.sessionId);
    expect(nextReview.questions.length).toBeGreaterThan(0);
    expect(
      nextReview.questions.every(
        (question) => !question.sourceId || !first.has(question.sourceId),
      ),
    ).toBe(true);
  });

  it("opens, saves and submits a review attempt through the quiz screen calls", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(book));
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    reachFrontier(db, plan.planId);
    const review = startReview(db, plan.planId);
    expect(review.attemptId).not.toBe("");
    const read = readQuiz(db, review.attemptId, plan.planId);
    expect(read.state).toBe("succeeded");
    expect(read.questions.map((question) => question.id)).toEqual(
      review.questions.map((question) => question.id),
    );
    saveQuizDraft(db, review.attemptId, {}, 1, plan.planId);
    const scored = submitAttempt(db, review.attemptId, {});
    expect(scored.results).toHaveLength(review.questions.length);
    expect(readQuiz(db, review.attemptId, plan.planId).result?.score).toBe(0);
  });

  it("does not spread a flag or a perfect score onto another book", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const first = importSmartbook(db, pack(book));
    const second = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "altro",
          title: "Altro",
          access: "public",
          chapters: [{ id: "c9", number: 1, title: "Altro", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Altro\nUn testo diverso.\n",
        "esercizi.md":
          ':::exercise{id="z0" chapter="1"}\nDomanda?\n:::solution\nrisposta\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, {
      title: "Due",
      sourceIds: [first.sourceId, second.sourceId],
    });
    const topics = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ id: string }>;
    const secondTopic = topics[1];
    expect(secondTopic).toBeTruthy();
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('evt-perfect', 'answer_given', ?, ?, '{"score":1}', 2)`,
    ).run(plan.planId, secondTopic?.id);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('evt-old', 'answer_given', ?, ?, '{"score":0}', 1)`,
    ).run(plan.planId, secondTopic?.id);
    const review = startReview(db, plan.planId);
    const foreign = db
      .prepare(
        `SELECT e.id FROM exercises e
         JOIN smartbooks sb ON sb.id = e.smartbook_id
         WHERE sb.source_id = ?`,
      )
      .all(second.sourceId) as Array<{ id: string }>;
    const foreignIds = new Set(foreign.map((row) => row.id));
    expect(
      review.questions.some(
        (question) => question.sourceId && foreignIds.has(question.sourceId),
      ),
    ).toBe(false);
    const own = db
      .prepare(
        `SELECT e.id FROM exercises e
         JOIN smartbooks sb ON sb.id = e.smartbook_id
         WHERE sb.source_id = ? LIMIT 1`,
      )
      .get(first.sourceId) as { id: string };
    flagTarget(db, "exercise", own.id);
    syncGaps(db, plan.planId);
    const gaps = db
      .prepare(
        `SELECT topic_id FROM gaps WHERE plan_id = ? AND closed_at IS NULL`,
      )
      .all(plan.planId) as Array<{ topic_id: string }>;
    expect(gaps.map((row) => row.topic_id)).toEqual([topics[0]?.id]);
  });

  it("skips new items on a frontier topic whose latest score is perfect, and brings them back after a miss", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(book));
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    reachFrontier(db, plan.planId);
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as { id: string };
    const insert = db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    );
    insert.run("evt-perfect", plan.planId, topic.id, '{"score":1}', 2);
    expect(startReview(db, plan.planId).questions).toEqual([]);
    insert.run("evt-miss", plan.planId, topic.id, '{"score":0}', 3);
    expect(startReview(db, plan.planId).questions.length).toBeGreaterThan(0);
  });
});
