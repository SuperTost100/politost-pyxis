import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { syncGaps } from "../plans/progress";
import { importSmartbook } from "../sources/smartbook";
import { flagTarget } from "./flags";
import { mixQuestions } from "./mix";
import { writeLesson } from "./openLesson";
import { startReview } from "./review";
import { startTopicQuiz, submitAttempt } from "./topicQuiz";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
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
    const nextReview = startReview(db, plan.planId);
    expect(nextReview.questions.length).toBeGreaterThan(0);
    expect(
      nextReview.questions.every(
        (question) => !question.sourceId || !first.has(question.sourceId),
      ),
    ).toBe(true);
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

  it("does not review a topic whose latest score is perfect", () => {
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
    const insert = db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    );
    insert.run("evt-miss", plan.planId, topic.id, '{"score":0}', 1);
    insert.run("evt-perfect", plan.planId, topic.id, '{"score":1}', 2);
    expect(startReview(db, plan.planId).questions).toEqual([]);
  });

  it("keeps a perfect frontier out of the new questions when five other topics are weak", () => {
    const chapters = [1, 2, 3, 4, 5, 6];
    const files: Record<string, string> = {
      "smartbook.json": JSON.stringify({
        id: "sei",
        title: "Sei",
        access: "public",
        chapters: chapters.map((number) => ({
          id: `c${number}`,
          number,
          title: `Tema ${number}`,
          file: `0${number}.md`,
        })),
      }),
      "esercizi.md": chapters
        .map(
          (number) =>
            `:::exercise{id="q${number}" chapter="${number}"}\nDomanda ${number}?\n:::solution\nrisposta ${number}\n:::\n:::\n`,
        )
        .join("\n"),
    };
    for (const number of chapters) {
      files[`chapters/0${number}.md`] =
        `## p1 | Tema ${number}\nTesto ${number}.\n`;
    }
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(files));
    const plan = createPlan(db, {
      title: "Sei",
      sourceIds: [imported.sourceId],
    });
    const topics = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ id: string }>;
    const insert = db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    );
    const frontier = topics[0];
    expect(frontier).toBeTruthy();
    insert.run("evt-frontier", plan.planId, frontier?.id, '{"score":1}', 1);
    topics.slice(1).forEach((topic, index) => {
      insert.run(
        `evt-weak-${index}`,
        plan.planId,
        topic.id,
        '{"score":0}',
        10 + index,
      );
    });
    const frontierExercises = new Set(
      (
        db
          .prepare(
            `SELECT id FROM exercises WHERE json_extract(locator_json, '$.chapter') = 1`,
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const review = startReview(db, plan.planId);
    expect(
      review.questions.some(
        (question) =>
          question.sourceId && frontierExercises.has(question.sourceId),
      ),
    ).toBe(false);
  });

  it("does not treat a perfect topic as new when newer weak events fill the window", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(book));
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    const frontier = db
      .prepare(
        `SELECT id FROM topics WHERE plan_id = ? ORDER BY position LIMIT 1`,
      )
      .get(plan.planId) as { id: string };
    const other = "topic-other";
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, 'Altro', 5, 1)`,
    ).run(other, plan.planId);
    const insert = db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, ?)`,
    );
    insert.run("evt-perfect", plan.planId, frontier.id, '{"score":1}', 1);
    for (let index = 0; index < 20; index += 1) {
      insert.run(
        `evt-weak-${index}`,
        plan.planId,
        other,
        '{"score":0}',
        10 + index,
      );
    }
    const own = new Set(
      (
        db.prepare(`SELECT id FROM exercises`).all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const review = startReview(db, plan.planId);
    expect(
      review.questions.some(
        (question) => question.sourceId && own.has(question.sourceId),
      ),
    ).toBe(false);
    const tied = db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, ?, 1000)`,
    );
    tied.run("evt-tie-perfect", plan.planId, frontier.id, '{"score":1}');
    tied.run("evt-tie-miss", plan.planId, frontier.id, '{"score":0}');
    expect(startReview(db, plan.planId).questions.length).toBeGreaterThan(0);
  });

  it("still reviews a weak topic when another topic has twenty newer misses", () => {
    const chapters = [1, 2, 3];
    const files: Record<string, string> = {
      "smartbook.json": JSON.stringify({
        id: "tre",
        title: "Tre",
        access: "public",
        chapters: chapters.map((number) => ({
          id: `c${number}`,
          number,
          title: `Tema ${number}`,
          file: `0${number}.md`,
        })),
      }),
      "esercizi.md": chapters
        .map(
          (number) =>
            `:::exercise{id="q${number}" chapter="${number}"}\nDomanda ${number}?\n:::solution\nrisposta ${number}\n:::\n:::\n`,
        )
        .join("\n"),
    };
    for (const number of chapters) {
      files[`chapters/0${number}.md`] =
        `## p1 | Tema ${number}\nTesto ${number}.\n`;
    }
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const imported = importSmartbook(db, pack(files));
    const plan = createPlan(db, {
      title: "Tre",
      sourceIds: [imported.sourceId],
    });
    const topics = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ id: string }>;
    const insert = db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES (?, 'answer_given', ?, ?, '{"score":0}', ?)`,
    );
    for (let index = 0; index < 20; index += 1) {
      insert.run(`evt-a-${index}`, plan.planId, topics[1]?.id, 100 + index);
    }
    insert.run("evt-b", plan.planId, topics[2]?.id, 1);
    const third = new Set(
      (
        db
          .prepare(
            `SELECT id FROM exercises WHERE json_extract(locator_json, '$.chapter') = 3`,
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
    const review = startReview(db, plan.planId);
    expect(
      review.questions.some(
        (question) => question.sourceId && third.has(question.sourceId),
      ),
    ).toBe(true);
  });
});
