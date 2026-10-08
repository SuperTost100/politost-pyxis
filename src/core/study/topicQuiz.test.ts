import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan, deletePlan, readPlan } from "../plans/create";
import { recordStep } from "../plans/steps";
import { importSmartbook } from "../sources/smartbook";
import { studyHandlers } from "./handlers";
import { readQuiz } from "./quizJobs";
import { submitAttempt } from "./topicQuiz";
import { flagTarget } from "./flags";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

describe("diagnostic", () => {
  it("model-grades equivalent open wording and finishes the diagnostic node", async () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale?\n:::solution\n10 N\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    recordStep(db, plan.planId, { activity: "intro" });
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "review-model" }));
    const study = studyHandlers(db, undefined, async (input) => {
      expect(input.prompt).toContain("ten newtons");
      return {
        text: '{"score":1,"explanation":"Equivalent units and value."}',
        structured: { score: 1, explanation: "Equivalent units and value." },
        model: "grading-model",
        provider: "claude",
        inputTokens: 1,
      };
    });
    const started = study.diagnosticStart({ planId: plan.planId });
    const question = started.questions[0];
    await study.quizSubmit({
      attemptId: started.attemptId,
      picks: { [question?.id ?? ""]: "ten newtons" },
    });
    // Submitting the diagnostic records it as a step with its score.
    expect(readPlan(db, plan.planId)?.steps.at(-1)).toMatchObject({
      activity: "diagnostic",
      topicId: null,
      result: { correct: 1, total: 1 },
    });
    const event = db
      .prepare(
        `SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given'`,
      )
      .get() as { topic_id: string; payload_json: string };
    expect(event.topic_id).toBeTruthy();
    expect(JSON.parse(event.payload_json).score).toBe(1);
    expect(() => deletePlan(db, plan.planId)).not.toThrow();
    expect(readPlan(db, plan.planId)).toBeNull();
  });

  it("finishes the diagnosis when the book has no answers", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "notes",
          title: "Note",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nSolo testo.\n",
      }),
    );
    const plan = createPlan(db, {
      title: "Note",
      sourceIds: [imported.sourceId],
    });
    recordStep(db, plan.planId, { activity: "intro" });
    const study = studyHandlers(db);
    expect(study.diagnosticStart({ planId: plan.planId }).questions).toEqual(
      [],
    );
    expect(readPlan(db, plan.planId)?.steps.map((step) => step.activity)).toEqual([
      "intro",
      "diagnostic",
    ]);
    // Opening it again adds nothing.
    studyHandlers(db).diagnosticStart({ planId: plan.planId });
    expect(readPlan(db, plan.planId)?.steps).toHaveLength(2);
  });

  it("takes unflagged questions from each topic and only from that topic's book", () => {
    const db = openDatabase(":memory:");
    const many = Array.from(
      { length: 20 },
      (_, index) =>
        `:::exercise{id="a${index}" chapter="1"}\nA${index}\n:::solution\n1\n:::\n:::\n`,
    ).join("\n");
    const first = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "one",
          title: "Uno",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Moti", file: "01.md" },
            { id: "c2", number: 2, title: "Forze", file: "02.md" },
          ],
        }),
        "chapters/01.md": "## p1 | Energia\nUno.\n",
        "chapters/02.md": "## p2 | Forze\nDue.\n",
        "esercizi.md": `${many}\n:::exercise{id="b1" chapter="2"}\nFROM2\n:::solution\n2\n:::\n:::\n`,
      }),
    );
    const second = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "two",
          title: "Due",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nAltro.\n",
        "esercizi.md":
          ':::exercise{id="z1" chapter="1"}\nOTHER\n:::solution\n9\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, {
      title: "Mix",
      sourceIds: [first.sourceId, second.sourceId],
    });
    const rejected = db.prepare("SELECT id FROM exercises WHERE prompt = 'A0'").get() as { id: string };
    flagTarget(db, "exercise", rejected.id, "Wrong answer");
    recordStep(db, plan.planId, { activity: "intro" });
    const started = studyHandlers(db).diagnosticStart({ planId: plan.planId });
    const stems = started.questions.map((question) => question.stem);
    expect(stems).not.toContain("A0");
    expect(stems).toContain("FROM2");
    expect(stems).toContain("OTHER");
    expect(stems.filter((stem) => stem === "OTHER")).toHaveLength(1);
    expect(started.questions).toHaveLength(10);
  });

  it("resumes the open diagnostic with its draft and freezes it after submit", () => {
    const db = openDatabase(":memory:");
    const book = (id: string, answer: string) =>
      importSmartbook(
        db,
        pack({
          "smartbook.json": JSON.stringify({
            id,
            title: id,
            access: "public",
            chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
          }),
          "chapters/01.md": "## p1 | Energia\nTesto.\n",
          "esercizi.md": `:::exercise{id="e1" chapter="1"}\nQ ${id}\n:::solution\n${answer}\n:::\n:::\n`,
        }),
      );
    const make = (title: string, sourceId: string) => {
      const plan = createPlan(db, { title, sourceIds: [sourceId] });
      recordStep(db, plan.planId, { activity: "intro" });
      return plan.planId;
    };
    const planA = make("A", book("a", "10").sourceId);
    const planB = make("B", book("b", "20").sourceId);
    const study = studyHandlers(db);
    const first = study.diagnosticStart({ planId: planA });
    const questionId = first.questions[0]!.id;
    study.quizDraft({
      attemptId: first.attemptId,
      picks: { [questionId]: "dieci" },
      index: 0,
    });

    // A reload restarts the diagnostic: same attempt, same questions, saved draft.
    const resumed = study.diagnosticStart({ planId: planA });
    expect(resumed.attemptId).toBe(first.attemptId);
    expect(resumed.questions.map((q) => q.id)).toEqual(
      first.questions.map((q) => q.id),
    );
    const read = readQuiz(db, first.attemptId, planA);
    expect(read.draft?.picks).toEqual({ [questionId]: "dieci" });
    expect(read.state).toBe("succeeded");
    expect(read.questions[0]?.grade.kind).toBe("open");
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
      n: 1,
    });

    // Another plan neither resumes nor reads this attempt.
    expect(() => readQuiz(db, first.attemptId, planB)).toThrow("quiz-missing");
    expect(() =>
      study.quizRead({ attemptId: first.attemptId, planId: planB }),
    ).toThrow("quiz-missing");
    expect(() =>
      study.quizDraft({
        attemptId: first.attemptId,
        planId: planB,
        picks: {},
        index: 0,
      }),
    ).toThrow("attempt-closed");
    expect(study.diagnosticStart({ planId: planB }).attemptId).not.toBe(
      first.attemptId,
    );

    // Once submitted the attempt is frozen: no more drafts, and a restart is a fresh attempt.
    submitAttempt(db, first.attemptId, { [questionId]: "dieci" });
    expect(() =>
      study.quizDraft({
        attemptId: first.attemptId,
        picks: { [questionId]: "altro" },
        index: 0,
      }),
    ).toThrow("attempt-closed");
    expect(readQuiz(db, first.attemptId, planA).result?.picks).toEqual({
      [questionId]: "dieci",
    });
    expect(study.diagnosticStart({ planId: planA }).attemptId).not.toBe(
      first.attemptId,
    );
  });
});
