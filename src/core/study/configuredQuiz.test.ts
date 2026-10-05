import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import {
  enqueueQuiz,
  readQuiz,
  registerQuizJobs,
  saveQuizDraft,
} from "./quizJobs";
import { generateQuiz, prepareQuiz, saveQuizSnapshot, startConfiguredQuiz } from "./configuredQuiz";
import { gradeConfiguredAttempt, gradeQuizQuestion } from "./quizGrading";
import { submitAttempt } from "./attempt";
import type { GenerateInput } from "../engine/generate";
import { partialText, systemPrompt, templateVersion } from "../engine/prompts";

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Physics', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Motion', 0, 1)",
  ).run();
  db.prepare(
    "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('src', 'pdf', 'Notes', 'ready', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'src', 1, '{}', 1)",
  ).run();
  db.prepare(
    "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES ('p', 'src', 'doc', 'Velocity is displacement per time.', 1)",
  ).run();
  db.prepare(
    "INSERT INTO topic_passages (topic_id, passage_id) VALUES ('topic', 'p')",
  ).run();
  return db;
}
function reply(structured: unknown) {
  return {
    structured,
    text: JSON.stringify(structured),
    provider: "claude",
    model: "test-model",
    inputTokens: 1,
  };
}
const tfRun: GenerateInput["run"] = async (input) => {
  const content = JSON.parse(input.prompt) as {
    count: number;
    previousQuestions: string[];
  };
  return reply({
    questions: Array.from({ length: content.count }, (_, i) => ({
      kind: "tf",
      stem: `Statement ${content.previousQuestions.length + i}`,
      explanation: "Velocity describes displacement per time.",
      passageIds: ["p"],
      correct: true,
    })),
  });
};
async function until(
  db: ReturnType<typeof openDatabase>,
  attemptId: string,
  state: string,
) {
  for (let i = 0; i < 200; i++) {
    if (readQuiz(db, attemptId).state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(JSON.stringify(readQuiz(db, attemptId)));
}
describe("configured quizzes", () => {
  it("builds exactly 100 distinct questions in ten sequential validated batches", async () => {
    const db = fixture();
    let calls = 0;
    const systems = new Set<string>();
    const started = await startConfiguredQuiz(
      db,
      { planId: "plan", topicId: "topic", count: 100, types: ["tf"] },
      async (input) => {
        calls++;
        systems.add(input.system ?? "");
        return tfRun!(input);
      },
    );
    // Every batch gets the same filled system text, with language and the shared citation rule.
    expect(systems.size).toBe(1);
    const [system] = [...systems];
    expect(system).toMatch(/^Create distinct/);
    expect(system).toContain("Write all output in Italian.");
    expect(system).toContain(partialText("citation"));
    expect(system).not.toMatch(/\{\{[A-Za-z]/);
    expect(
      db.prepare("SELECT prompt_template, prompt_version FROM items").get(),
    ).toEqual({
      prompt_template: "quiz.batch",
      prompt_version: templateVersion("quiz.batch"),
    });
    expect(started.questions).toHaveLength(100);
    expect(
      new Set(started.questions.map((question) => question.stem)).size,
    ).toBe(100);
    expect(calls).toBe(10);
    expect(JSON.stringify(started)).not.toContain('"correct"');
    expect(db.prepare("SELECT model_id FROM items").get()).toEqual({
      model_id: "test-model",
    });
    db.close();
  });
  it("balances mixed question kinds and keeps shuffled MCQ answers aligned", async () => {
    const db = fixture();
    const started = await startConfiguredQuiz(
      db,
      { planId: "plan", topicId: "topic", count: 20 },
      async (input) => {
        const content = JSON.parse(input.prompt) as {
          questionKinds: string[];
          previousQuestions: string[];
        };
        return reply({
          questions: content.questionKinds.map((kind, i) => {
            const n = content.previousQuestions.length + i;
            const base = {
              kind,
              stem: `Question ${n}`,
              explanation: "Explanation",
              passageIds: ["p"],
            };
            if (kind === "tf") return { ...base, correct: true };
            if (kind === "mcq")
              return {
                ...base,
                options: ["right", "wrong1", "wrong2", "wrong3"],
                correct: 0,
              };
            if (kind === "completion")
              return {
                ...base,
                stem: `Question ${n}: {{1}}`,
                accepted: ["right"],
              };
            if (kind === "matching")
              return {
                ...base,
                pairs: [
                  ["a", "1"],
                  ["b", "2"],
                  ["c", "3"],
                ],
              };
            return {
              ...base,
              reference: "Reference",
              rubric: ["Accuracy", "Coverage"],
            };
          }),
        });
      },
    );
    for (const kind of ["mcq", "tf", "completion", "matching", "open"])
      expect(
        started.questions.filter((question) => question.grade.kind === kind),
      ).toHaveLength(4);
    const body = JSON.parse(
      (db.prepare("SELECT body_json FROM items").get() as { body_json: string })
        .body_json,
    ) as {
      questions: Array<{
        options?: string[];
        answer: { kind: string; correct?: number };
      }>;
    };
    for (const question of body.questions.filter(
      (row) => row.answer.kind === "mcq",
    ))
      expect(question.options![question.answer.correct!]).toBe("right");
    db.close();
  });
  it("publishes the first batch and retries only after its saved checkpoint", async () => {
    const db = fixture();
    const runner = createRunner(db, () => {});
    let fail = true;
    let firstBatchCalls = 0;
    registerQuizJobs(db, runner, async (input) => {
      const content = JSON.parse(input.prompt) as {
        previousQuestions: string[];
      };
      if (!content.previousQuestions.length) firstBatchCalls++;
      if (fail && content.previousQuestions.length) throw new Error("offline");
      return tfRun!(input);
    });
    const started = enqueueQuiz(db, runner, {
      planId: "plan",
      topicId: "topic",
      count: 20,
      types: ["tf"],
    });
    await until(db, started.attemptId, "failed");
    const partial = readQuiz(db, started.attemptId);
    expect(partial.questions).toHaveLength(10);
    await expect(
      gradeConfiguredAttempt(db, started.attemptId, {}),
    ).rejects.toThrow("quiz-building");
    const firstId = partial.questions[0]!.id;
    runner.dismiss(partial.jobId!);
    fail = false;
    runner.retry(partial.jobId!);
    await until(db, started.attemptId, "succeeded");
    expect(firstBatchCalls).toBe(1);
    expect(readQuiz(db, started.attemptId).questions[0]!.id).toBe(firstId);
    expect(readQuiz(db, started.attemptId).questions).toHaveLength(20);
    db.close();
  });
  it("stores model feedback once, locks checked answers, and reuses grades on submit", async () => {
    const db = fixture();
    const started = await startConfiguredQuiz(
      db,
      { planId: "plan", topicId: "topic", count: 10, types: ["open"] },
      async () =>
        reply({
          questions: Array.from({ length: 10 }, (_, i) => ({
            kind: "open",
            stem: `Define velocity ${i}`,
            explanation: "Displacement per time.",
            reference: "Displacement per time",
            rubric: ["Defines displacement", "Includes time"],
            passageIds: ["p"],
          })),
        }),
    );
    let calls = 0;
    const run: GenerateInput["run"] = async (input) => {
      calls++;
      // Grading answers in the reference's language, so it takes no placeholder.
      expect(input.system).toBe(systemPrompt("quiz.open-grade"));
      return reply({ score: 1, explanation: "Equivalent wording accepted." });
    };
    const id = started.questions[0]!.id;
    const check = await gradeQuizQuestion(
      db,
      started.attemptId,
      id,
      "How fast displacement changes",
      run,
    );
    expect(check.model).toBe("test-model");
    await expect(
      gradeQuizQuestion(db, started.attemptId, id, "different", run),
    ).rejects.toThrow("answer-locked");
    const grades = await gradeConfiguredAttempt(
      db,
      started.attemptId,
      { [id]: check.pick },
      run,
    );
    expect(calls).toBe(1);
    const results = submitAttempt(
      db,
      started.attemptId,
      { [id]: check.pick },
      Date.now(),
      grades,
    );
    expect(results.score).toBe(0.1);
    expect(results.results[0]!.explanation).toBe(check.explanation);
    expect(() =>
      submitAttempt(db, started.attemptId, {}, Date.now(), grades),
    ).toThrow("attempt-closed");
    db.close();
  });
  it("scopes a quiz to the whole plan or one source page and refuses an empty page", async () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, locator_json, created_at) VALUES ('p3', 'src', 'doc', 'Page three text.', '{\"page\":3}', 2)",
    ).run();
    db.prepare(
      "INSERT INTO topic_passages (topic_id, passage_id) VALUES ('topic', 'p3')",
    ).run();
    const seen: string[][] = [];
    const run: GenerateInput["run"] = async (input) => {
      const content = JSON.parse(input.prompt) as {
        passages: Array<{ id: string }>;
      };
      seen.push(content.passages.map((row) => row.id));
      return reply({
        questions: Array.from({ length: 10 }, (_, i) => ({
          kind: "tf",
          stem: `Statement ${seen.length}-${i}`,
          explanation: "Because.",
          passageIds: [content.passages[0]!.id],
          correct: true,
        })),
      });
    };
    const base = { planId: "plan", count: 10, types: ["tf" as const] };
    await startConfiguredQuiz(db, { ...base, scope: "plan" }, run);
    await startConfiguredQuiz(
      db,
      { ...base, scope: "page", sourceId: "src", page: 3 },
      run,
    );
    expect(seen[0]).toEqual(["p", "p3"]);
    expect(seen[1]).toEqual(["p3"]);
    // Plan and page quizzes belong to no single topic and keep their scope.
    const rows = db
      .prepare("SELECT topic_id, body_json FROM items ORDER BY created_at")
      .all() as Array<{ topic_id: string | null; body_json: string }>;
    expect(rows.map((row) => row.topic_id)).toEqual([null, null]);
    expect(
      rows.map((row) => JSON.parse(row.body_json).config.scope).sort(),
    ).toEqual(["page", "plan"]);
    await expect(
      startConfiguredQuiz(
        db,
        { ...base, scope: "page", sourceId: "src", page: 9 },
        run,
      ),
    ).rejects.toThrow("page-empty");
    await expect(
      startConfiguredQuiz(db, { ...base, scope: "topic" }, run),
    ).rejects.toThrow("topic-missing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
      n: 2,
    });
    db.close();
  });
  it("starts the optional timer once the quiz is complete and keeps the deadline across reads", async () => {
    const db = fixture();
    const started = await startConfiguredQuiz(
      db,
      {
        planId: "plan",
        topicId: "topic",
        count: 10,
        types: ["tf"],
        timerMinutes: 5,
      },
      tfRun,
    );
    expect(readQuiz(db, started.attemptId)).toMatchObject({
      timerMinutes: 5,
      deadlineAt: undefined,
    });
    saveQuizDraft(db, started.attemptId, {}, 0, "plan");
    const first = readQuiz(db, started.attemptId).deadlineAt!;
    expect(first - Date.now()).toBeGreaterThan(299_000);
    saveQuizDraft(db, started.attemptId, {}, 1, "plan");
    expect(readQuiz(db, started.attemptId).deadlineAt).toBe(first);
    // Reopening after the deadline cannot extend it or add answers.
    db.prepare(
      "UPDATE attempt_answers SET payload_json = json_set(payload_json, '$.deadlineAt', ?)",
    ).run(Date.now() - 60_000);
    expect(() => saveQuizDraft(db, started.attemptId, {}, 1, "plan")).toThrow(
      "attempt-closed",
    );
    db.close();
  });
  it("rejects unsupported counts and invented grounding without saving a partial attempt", async () => {
    const db = fixture();
    await expect(
      startConfiguredQuiz(db, { planId: "plan", topicId: "topic", count: 101 }),
    ).rejects.toThrow();
    await expect(
      startConfiguredQuiz(
        db,
        { planId: "plan", topicId: "topic", count: 10, types: ["tf"] },
        async () =>
          reply({
            questions: Array.from({ length: 10 }, (_, i) => ({
              kind: "tf",
              stem: `Question ${i}`,
              explanation: "Explanation",
              passageIds: ["invented"],
              correct: true,
            })),
          }),
      ),
    ).rejects.toMatchObject({ code: "invalid-output" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
      n: 0,
    });
    db.close();
  });
});

it("marks a quiz written without the plan's sources as general knowledge", async () => {
  const db = fixture();
  const ask = { planId: "plan", topicId: "topic", count: 10, types: ["tf" as const] };
  const sourced = await startConfiguredQuiz(db, ask, tfRun);
  expect(readQuiz(db, sourced.attemptId).general).toBeUndefined();
  db.prepare("DELETE FROM topic_passages").run();
  const general = await startConfiguredQuiz(db, ask, async () =>
    reply({
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "tf",
        stem: `Statement ${i}`,
        explanation: "Known background.",
        passageIds: [],
        correct: true,
      })),
    }),
  );
  expect(readQuiz(db, general.attemptId).general).toBe(true);
  db.close();
});

it("retains each batch model after retrying with another engine", async () => {
  const db = fixture(); const input = { planId: "plan", topicId: "topic", count: 20, types: ["tf" as const] };
  const snapshot = prepareQuiz(db, input);
  await expect(generateQuiz(snapshot, async (turn) => ({ ...(await tfRun(turn)), model: "model-A" }), undefined, () => { throw new Error("interrupted"); })).rejects.toThrow("interrupted");
  expect(snapshot.questions).toHaveLength(10);
  snapshot.selection = { provider: "claude", model: "model-B" };
  await generateQuiz(snapshot, async (turn) => ({ ...(await tfRun(turn)), model: "model-B" }));
  const id = saveQuizSnapshot(db, input, snapshot);
  const row = db.prepare("SELECT body_json, engine_provider, model_id FROM items WHERE id = ?").get(id) as { body_json: string; engine_provider: string | null; model_id: string | null };
  expect(JSON.parse(row.body_json).questions.map((q: { generatedBy: { model: string } }) => q.generatedBy.model)).toEqual([...Array(10).fill("model-A"), ...Array(10).fill("model-B")]);
  expect(row.engine_provider).toBeNull(); expect(row.model_id).toBeNull(); db.close();
});
