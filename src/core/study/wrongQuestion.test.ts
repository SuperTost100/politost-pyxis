import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { createRunner } from "../jobs/runner";
import { studyHandlers } from "./handlers";
import { readQuiz } from "./quizJobs";
import { latestGeneratedDiagnostic } from "./topicQuiz";

type Db = ReturnType<typeof openDatabase>;

/** A ready plan with two topics and a model-written diagnostic of `count` multiple-choice questions. */
function fixture(count: number) {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "default-model" }));
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
  const questions = Array.from({ length: count }, (_, i) => ({
    id: `q${i}`,
    stem: `Domanda ${i}`,
    options: ["giusta", "b", "c", "d"],
    explanation: "Perché sì.",
    topicId: i % 2 ? "t1" : "t0",
    answer: { kind: "mcq", picked: -1, correct: 0 },
  }));
  db.prepare(
    "INSERT INTO items (id, plan_id, kind, body_json, engine_provider, model_id, created_at) VALUES ('diag', 'plan', 'diagnostic', ?, 'claude', 'm', 1)",
  ).run(JSON.stringify({ questions }));
  return db;
}

function replacement(stem: string): GenerateInput["run"] {
  return async (input) => {
    const content = JSON.parse(input.prompt) as {
      count: number;
      rejectedQuestions?: string[];
    };
    expect(content.count).toBe(1);
    expect(content.rejectedQuestions).toContain("Domanda 0");
    const structured = {
      questions: [
        {
          kind: "mcq",
          stem,
          options: ["nuova", "x", "y", "z"],
          correct: 0,
          explanation: "Nuova spiegazione.",
          passageIds: [],
        },
      ],
    };
    return {
      structured,
      text: JSON.stringify(structured),
      provider: "claude",
      model: "writer",
      inputTokens: 1,
    };
  };
}

async function settled(db: Db, kind: string) {
  for (let i = 0; i < 400; i++) {
    const row = db
      .prepare("SELECT state FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT 1")
      .get(kind) as { state: string } | undefined;
    if (row && ["succeeded", "failed", "cancelled"].includes(row.state))
      return row.state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${kind} did not settle`);
}

describe("wrong question", () => {
  it("asks an older, longer diagnostic again as ten questions spread over its topics", () => {
    const db = fixture(18);
    const study = studyHandlers(db);
    expect(study.diagnosticPreview({ planId: "plan" })).toMatchObject({
      count: 10,
      answered: 0,
    });
    const started = study.diagnosticStart({ planId: "plan" });
    expect(started.questions).toHaveLength(10);
    const topics = readQuiz(db, started.attemptId).questions.map(
      (question) => question.topicId,
    );
    expect(topics.filter((topic) => topic === "t0")).toHaveLength(5);
    // The original item stays for the attempts already taken on it.
    expect(
      (JSON.parse(
        (db.prepare("SELECT body_json FROM items WHERE id = 'diag'").get() as { body_json: string })
          .body_json,
      ) as { questions: unknown[] }).questions,
    ).toHaveLength(18);
    db.close();
  });

  it("leaves a wrong question out of the score, undoes it, and writes a replacement for the diagnostic", async () => {
    const db = fixture(4);
    const runner = createRunner(db, () => {});
    const study = studyHandlers(db, runner, replacement("Domanda nuova"));
    const started = study.diagnosticStart({ planId: "plan" });
    const picks = { q0: "1", q1: "0", q2: "0", q3: "1" };
    for (const [questionId, pick] of Object.entries(picks))
      await study.quizCheck({ attemptId: started.attemptId, questionId, pick });
    study.quizSubmit({ attemptId: started.attemptId, picks });
    await settled(db, "quiz-grade");
    expect(study.quizRead({ attemptId: started.attemptId }).result?.score).toBe(0.5);

    // Undo before the replacement is written: the score and the diagnostic return as they were.
    expect(
      study.quizWrong({ attemptId: started.attemptId, questionId: "q0", wrong: true }),
    ).toEqual({ ok: true, score: 2 / 3 });
    const read = study.quizRead({ attemptId: started.attemptId });
    expect(read.result?.results.find((row) => row.id === "q0")?.flagged).toBe(true);
    expect(
      study.quizWrong({ attemptId: started.attemptId, questionId: "q0", wrong: false }),
    ).toEqual({ ok: true, score: 0.5 });
    expect(await settled(db, "quiz-replace")).toBe("cancelled");
    expect(latestGeneratedDiagnostic(db, "plan")?.id).toBe("diag");

    study.quizWrong({ attemptId: started.attemptId, questionId: "q0", wrong: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 400 && latestGeneratedDiagnostic(db, "plan")?.id === "diag"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const next = JSON.parse(latestGeneratedDiagnostic(db, "plan")!.body_json) as {
      questions: Array<{ id: string; stem: string; topicId: string }>;
    };
    expect(next.questions.map((question) => question.stem)).toEqual([
      "Domanda nuova",
      "Domanda 1",
      "Domanda 2",
      "Domanda 3",
    ]);
    expect(next.questions[0]!.topicId).toBe("t0");
    // The next diagnostic asks the replacement, never the question marked wrong.
    const again = study.diagnosticStart({ planId: "plan" });
    expect(again.questions.map((question) => question.stem)).not.toContain("Domanda 0");
    // Mastery evidence drops it too: the flag is the same one Progress already filters.
    expect(
      db.prepare("SELECT target_kind, target_id FROM flags").all(),
    ).toEqual([{ target_kind: "exercise", target_id: "q0" }]);
    db.close();
  });

  it("corrects a diagnostic one answer at a time and keeps a checked answer locked", async () => {
    const db = fixture(2);
    const study = studyHandlers(db);
    const started = study.diagnosticStart({ planId: "plan" });
    const check = await study.quizCheck({
      attemptId: started.attemptId,
      questionId: "q0",
      pick: "2",
    });
    expect(check).toMatchObject({ score: 0, expected: "giusta" });
    await expect(
      study.quizCheck({ attemptId: started.attemptId, questionId: "q0", pick: "0" }),
    ).rejects.toThrow("answer-locked");
    expect(study.quizRead({ attemptId: started.attemptId }).checked).toHaveLength(1);
    expect(study.diagnosticPreview({ planId: "plan" })).toMatchObject({
      count: 2,
      answered: 1,
    });
    db.close();
  });
});
