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
import { submitAttempt } from "./topicQuiz";
import { startTopicQuiz } from "./test-study";

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
  it("lays options out differently each attempt, the same for one seed, with the right one tracked", () => {
    const rows = ["forza", "energia", "lavoro", "potenza", "calore", "massa"].map((name, index) => ({
      id: `e${index}`,
      prompt: `Che cos'è ${name}?`,
      answer: name,
    }));
    const layout = (questions: ReturnType<typeof mixQuestions>) =>
      questions.flatMap((question) =>
        question.grade.kind === "mcq" ? [question.options!, question.grade.correct] : [],
      );
    const first = mixQuestions(rows, 20, 7);
    expect(layout(mixQuestions(rows, 20, 7))).toEqual(layout(first));
    for (const question of first)
      if (question.grade.kind === "mcq")
        expect(question.options![question.grade.correct]).toBe(question.explanation);
    // Without a seed each call draws its own, so repeated attempts on the same exercises differ.
    const layouts = new Set(Array.from({ length: 12 }, () => JSON.stringify(layout(mixQuestions(rows)))));
    expect(layouts.size).toBeGreaterThan(1);
    // The right option is not stuck in one place across attempts.
    const places = new Set<number>();
    for (let attempt = 0; attempt < 30; attempt++)
      for (const question of mixQuestions(rows))
        if (question.grade.kind === "mcq") places.add(question.grade.correct);
    expect(places.size).toBeGreaterThan(1);
  });

  it("never offers another exercise's worked solution as an option, and asks such an exercise open", () => {
    const worked = (n: number) =>
      `La media è\n\n$$\\bar{x} = ${n}$$\n\nGli scarti valgono ${n}, quindi la varianza è ${n * 2}.`;
    const rows = [1, 2, 3, 4, 5].map((n) => ({
      id: `w${n}`,
      prompt: `Calcola la varianza delle misure ${n}.`,
      answer: worked(n),
      topicId: "stat",
      kind: "exercise",
    }));
    const questions = mixQuestions(rows, 8, 7);
    expect(questions.length).toBeGreaterThan(0);
    // A worked solution is no option, no statement to judge, no blank and no matching column: it is asked open.
    expect(questions.every((question) => question.grade.kind === "open")).toBe(true);
    for (const question of questions) {
      const row = rows.find((item) => item.id === question.sourceId)!;
      expect(question.stem).toBe(row.prompt);
    }
    // Each exercise is asked once.
    expect(new Set(questions.map((question) => question.sourceId)).size).toBe(questions.length);
  });

  it("draws distractors only from short answers of the same topic and kind", () => {
    const short = (topicId: string, kind: string, names: string[]) =>
      names.map((name) => ({ id: `${topicId}-${name}`, prompt: `Che cos'è ${name}?`, answer: name, topicId, kind }));
    const rows = [
      ...short("vettori", "exercise", ["modulo", "versore", "prodotto scalare", "componente"]),
      // Another topic, with enough answers to fill options of its own.
      ...short("misure", "exercise", ["media", "varianza", "errore standard", "incertezza"]),
      // Same topic, another kind: a worked example's answer is not an option for an exercise.
      ...short("vettori", "example", ["esempio uno"]),
      // A long solution in the same topic is never a distractor.
      {
        id: "vettori-long",
        prompt: "Calcola il prodotto vettoriale.",
        answer: "Il prodotto vettoriale si calcola con il determinante\n\n$$\\vec a \\times \\vec b = (4,-2,-5)$$",
        topicId: "vettori",
        kind: "exercise",
      },
    ];
    const byAnswer = new Map(rows.map((row) => [row.answer, row]));
    for (let seed = 1; seed < 40; seed += 1) {
      for (const question of mixQuestions(rows, 20, seed)) {
        const row = rows.find((item) => item.id === question.sourceId)!;
        if (question.grade.kind === "mcq")
          for (const option of question.options!) {
            const from = byAnswer.get(option)!;
            expect(from.topicId).toBe(row.topicId);
            expect(from.kind).toBe(row.kind);
            expect(option.length).toBeLessThan(120);
          }
        if (question.grade.kind === "tf") {
          const shown = question.stem.slice(row.prompt.length).trim();
          expect(byAnswer.get(shown)?.topicId).toBe(row.topicId);
          expect(byAnswer.get(shown)?.kind).toBe(row.kind);
        }
        if (question.grade.kind === "matching") {
          const sources = question.sourceIds!.map((id) => rows.find((item) => item.id === id)!);
          expect(new Set(sources.map((item) => `${item.topicId}/${item.kind}`)).size).toBe(1);
        }
        if (row.id === "vettori-long") expect(question.grade.kind).toBe("open");
      }
    }
    // The lone worked example has no plausible distractors, so it is never a multiple choice.
    for (let seed = 1; seed < 40; seed += 1)
      for (const question of mixQuestions(rows, 20, seed))
        if (question.sourceId === "vettori-esempio uno") expect(question.grade.kind).not.toBe("mcq");
  });

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
