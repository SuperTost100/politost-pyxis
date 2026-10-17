import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { planMastery } from "../plans/progress";
import { readSteps } from "../plans/steps";
import { flagTarget } from "./flags";
import { studyHandlers } from "./handlers";
import { mistakesNotebook, startRedo } from "./notebook";
import { readQuiz } from "./quizJobs";
import { answerSmartCheck } from "./smartText";

type Db = ReturnType<typeof openDatabase>;

const mcq = (
  id: string,
  topicId: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  stem: `Domanda ${id}`,
  options: ["giusta", "b", "c", "d"],
  explanation: "Perché sì [P1].",
  topicId,
  sourceIds: ["p1"],
  answer: { kind: "mcq", picked: -1, correct: 0 },
  ...extra,
});

/** A plan with two topics, one passage, and a diagnostic of four multiple-choice questions. */
function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans (id, title, status, content_language, created_at, updated_at) VALUES ('plan', 'Fisica', 'ready', 'it', 1, 1)",
  ).run();
  for (const [id, position] of [
    ["t0", 0],
    ["t1", 1],
  ] as const)
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'plan', ?, ?, 1)",
    ).run(id, `Topic ${id}`, position);
  db.prepare(
    "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'file', 'Mazzoldi', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d', 's', 1, '{}', 1)",
  ).run();
  for (const id of ["p1", "p2"])
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, locator_json, created_at) VALUES (?, 's', 'd', 'Testo', ?, '{\"page\":12}', 1)",
    ).run(id, `Sezione ${id}`);
  const questions = [
    mcq("q0", "t0"),
    mcq("q1", "t0"),
    mcq("q2", "t1", { sourceId: "ex1" }),
    mcq("q3", "t1"),
  ];
  db.prepare(
    "INSERT INTO items (id, plan_id, kind, body_json, engine_provider, model_id, created_at) VALUES ('diag', 'plan', 'diagnostic', ?, 'claude', 'm', 1)",
  ).run(JSON.stringify({ questions }));
  return db;
}

/** Answers every question of a fresh attempt and hands it in, graded inline as the unit tests do. */
async function answer(
  db: Db,
  attemptId: string,
  picks: Record<string, string>,
) {
  const study = studyHandlers(db);
  for (const [questionId, pick] of Object.entries(picks))
    await study.quizCheck({ attemptId, questionId, pick });
  await study.quizSubmit({ attemptId, picks });
}

const entries = (db: Db) => mistakesNotebook(db, { planId: "plan" }).entries;
const stems = (db: Db) => entries(db).map((entry) => entry.stem);
const keyOf = (db: Db, stem: string) =>
  entries(db).find((entry) => entry.stem === stem)?.key ?? "gone";

describe("mistakes notebook", () => {
  it("keeps each wrongly answered question with its answer, the right one and its source", async () => {
    const db = fixture();
    const started = studyHandlers(db).diagnosticStart({ planId: "plan" });
    // q1 is left blank: an unanswered question is not a mistake.
    await answer(db, started.attemptId, { q0: "1", q2: "2", q3: "0" });
    const notebook = mistakesNotebook(db, {});
    expect(notebook.plans).toEqual([
      { id: "plan", title: "Fisica", subject: null, count: 2 },
    ]);
    // Topic order, then newest first. A book exercise is known by its exercise id, any other question by its wording.
    expect(notebook.entries.map((entry) => [entry.stem, entry.key])).toEqual([
      [
        "Domanda q0",
        JSON.stringify(["mcq", "Domanda q0", ["b", "c", "d", "giusta"]]),
      ],
      ["Domanda q2", "ex1"],
    ]);
    expect(notebook.entries[0]).toMatchObject({
      origin: "diagnostic",
      topicId: "t0",
      topicTitle: "Topic t0",
      planTitle: "Fisica",
      stem: "Domanda q0",
      kind: "mcq",
      pick: "1",
      expected: "giusta",
      explanation: "Perché sì [P1].",
      citations: [{ passageId: "p1", label: "Sezione p1" }],
      passageId: "p1",
    });
    db.close();
  });

  it("leaves out questions marked wrong and topics a rebuild archived", async () => {
    const db = fixture();
    const started = studyHandlers(db).diagnosticStart({ planId: "plan" });
    await answer(db, started.attemptId, { q0: "1", q1: "1", q2: "2", q3: "3" });
    expect(stems(db)).toEqual([
      "Domanda q0",
      "Domanda q1",
      "Domanda q2",
      "Domanda q3",
    ]);
    // A book exercise is known by its exercise id.
    expect(keyOf(db, "Domanda q2")).toBe("ex1");
    flagTarget(db, "exercise", "ex1", "wrong-question");
    flagTarget(db, "exercise", "q0", "wrong-question");
    expect(stems(db)).toEqual(["Domanda q1", "Domanda q3"]);
    db.prepare("UPDATE topics SET archived_at = 2 WHERE id = 't1'").run();
    expect(stems(db)).toEqual(["Domanda q1"]);
    db.close();
  });

  it("asks a question again: right takes it out, wrong brings it back, and it counts like a quiz answer", async () => {
    const db = fixture();
    const study = studyHandlers(db);
    const started = study.diagnosticStart({ planId: "plan" });
    await answer(db, started.attemptId, { q0: "1", q1: "0", q2: "0", q3: "0" });
    expect(stems(db)).toEqual(["Domanda q0"]);
    const steps = readSteps(db, "plan").length;
    const before = planMastery(db, "plan").find(
      (topic) => topic.id === "t0",
    )!.mastery;

    const q0 = keyOf(db, "Domanda q0");
    const redo = startRedo(db, { planId: "plan", keys: [q0, "gone"] });
    const quiz = readQuiz(db, redo.attemptId, "plan");
    expect(quiz.state).toBe("succeeded");
    expect(quiz.questions).toEqual([
      expect.objectContaining({
        id: "q0",
        topicId: "t0",
        grade: { kind: "mcq" },
      }),
    ]);
    await answer(db, redo.attemptId, { q0: "0" });
    expect(stems(db)).toEqual([]);
    // One more right quiz answer on t0, and no step on the path.
    expect(
      planMastery(db, "plan").find((topic) => topic.id === "t0")!.mastery,
    ).toBeGreaterThan(before);
    expect(readSteps(db, "plan")).toHaveLength(steps);
    const event = db
      .prepare(
        "SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get() as { topic_id: string; payload_json: string };
    expect(event.topic_id).toBe("t0");
    expect(JSON.parse(event.payload_json)).toMatchObject({
      evidenceKind: "quiz",
      attemptId: redo.attemptId,
      questionScores: [expect.objectContaining({ id: "q0", score: 1 })],
    });

    // A later miss, in any quiz, puts it back.
    const again = study.diagnosticStart({ planId: "plan" });
    await answer(db, again.attemptId, { q0: "2", q1: "0", q2: "0", q3: "0" });
    expect(mistakesNotebook(db, { planId: "plan" }).entries).toMatchObject([
      { key: q0, origin: "diagnostic", pick: "2" },
    ]);
    const second = startRedo(db, { planId: "plan", keys: [q0] });
    await answer(db, second.attemptId, { q0: "3" });
    expect(mistakesNotebook(db, { planId: "plan" }).entries).toMatchObject([
      { key: q0, origin: "redo", pick: "3" },
    ]);
    expect(() =>
      startRedo(db, { planId: "plan", keys: [keyOf(db, "Domanda q1")] }),
    ).toThrow("question-missing");
    db.close();
  });

  it("joins copies of one question asked in different quizzes, and a flag on one copy hides them all", async () => {
    const db = fixture();
    const quiz = (
      id: string,
      questionId: string,
      options: string[],
      correct: number,
    ) => {
      db.prepare(
        "INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, 'plan', 't0', 'quiz', ?, 1)",
      ).run(
        id,
        JSON.stringify({
          complete: true,
          questions: [
            {
              ...mcq(questionId, "t0"),
              stem: `Stessa  domanda`,
              options,
              answer: { kind: "mcq", picked: -1, correct },
            },
          ],
        }),
      );
      db.prepare(
        "INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES (?, 'plan', ?, 2)",
      ).run(`at-${id}`, id);
    };
    // The second quiz shuffled the options and spaced the stem differently.
    quiz("quiz-a", "a1", ["giusta", "b", "c", "d"], 0);
    quiz("quiz-b", "b1", ["d", "c", "b", "giusta"], 3);
    await answer(db, "at-quiz-a", { a1: "1" });
    await answer(db, "at-quiz-b", { b1: "0" });
    expect(entries(db)).toMatchObject([
      { stem: "Stessa  domanda", pick: "0", expected: "giusta" },
    ]);
    flagTarget(db, "exercise", "a1", "wrong-question");
    expect(stems(db)).toEqual([]);
    db.close();
  });

  it("collects a missed lesson check, sourced from the passage cited before it, and asks it as a quiz question", async () => {
    const db = fixture();
    const markdown = [
      "La velocità [P1].",
      "",
      "L'accelerazione [P2].",
      "",
      "```pyxis-check",
      JSON.stringify({
        question: "Che cosa cambia l'accelerazione?",
        options: ["La velocità", "La massa"],
        answer: 0,
        explanation: "Per definizione.",
      }),
      "```",
    ].join("\n");
    db.prepare(
      "INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('lesson', 'plan', 't1', 'lesson', ?, 1)",
    ).run(JSON.stringify({ markdown, passageIds: ["p1", "p2"] }));
    const { parseSmartText, smartQuestions } =
      await import("../../shared/smart-text");
    const [blockId, question] = [
      ...smartQuestions(parseSmartText(markdown)),
    ][0]!;
    const wrong = question.options.findIndex((option) => option === "La massa");
    answerSmartCheck(db, {
      planId: "plan",
      itemId: "lesson",
      blockId,
      pick: wrong,
    });
    expect(mistakesNotebook(db, { planId: "plan" }).entries).toMatchObject([
      {
        origin: "check",
        topicId: "t1",
        kind: "mcq",
        pick: String(wrong),
        expected: "La velocità",
        passageId: "p2",
      },
    ]);
    const redo = startRedo(db, {
      planId: "plan",
      keys: [keyOf(db, "Che cosa cambia l'accelerazione?")],
    });
    expect(readQuiz(db, redo.attemptId).questions).toEqual([
      expect.objectContaining({
        id: blockId,
        stem: "Che cosa cambia l'accelerazione?",
        topicId: "t1",
      }),
    ]);
    await answer(db, redo.attemptId, { [blockId]: String(question.answer) });
    expect(stems(db)).toEqual([]);
    db.close();
  });

  it("asks a simulation question again as an open answer graded against its reference", () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('sim', 'plan', 'simulation', ?, 1)",
    ).run(
      JSON.stringify({
        minutes: 60,
        questions: [
          {
            id: "s1",
            topicId: "t1",
            passageIds: ["p2"],
            stem: "Ricava la legge oraria.",
            answer: { kind: "completion", accepted: [["x = x0 + v t"]] },
          },
        ],
      }),
    );
    db.prepare(
      "INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('sa', 'plan', 'sim', 5, 6)",
    ).run();
    db.prepare(
      "INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('aa', 'sa', ?, 6)",
    ).run(
      JSON.stringify({
        picks: { s1: "x = v t" },
        score: 0.4,
        results: [
          {
            id: "s1",
            score: 0.4,
            expected: "x = x0 + v t",
            explanation: "Manca x0.",
          },
        ],
      }),
    );
    expect(mistakesNotebook(db, { planId: "plan" }).entries).toMatchObject([
      {
        origin: "simulation",
        kind: "open",
        pick: "x = v t",
        score: 0.4,
        passageId: "p2",
      },
    ]);
    const redo = startRedo(db, {
      planId: "plan",
      keys: [keyOf(db, "Ricava la legge oraria.")],
    });
    const body = db
      .prepare(
        "SELECT i.topic_id, i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?",
      )
      .get(redo.attemptId) as { topic_id: string | null; body_json: string };
    expect(body.topic_id).toBeNull();
    expect(JSON.parse(body.body_json)).toMatchObject({
      redo: true,
      complete: true,
      questions: [
        {
          id: "s1",
          topicId: "t1",
          sourceIds: ["p2"],
          answer: { kind: "open", reference: "x = x0 + v t" },
        },
      ],
    });
    db.close();
  });
});
