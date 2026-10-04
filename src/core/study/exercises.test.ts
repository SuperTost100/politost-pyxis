import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { createRunner } from "../jobs/runner";
import { exerciseView, solutionSteps, topicExercises } from "./exercises";
import {
  enqueueExercises,
  exerciseJob,
  registerExerciseJobs,
} from "./exerciseJobs";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("solutionSteps", () => {
  it("splits at blank lines but not inside math or code blocks", () => {
    expect(
      solutionSteps(
        "Set up.\n\n$$\na = b\n\nc = d\n$$\n\n```py\nx = 1\n\ny = 2\n```\n\nDone.",
      ),
    ).toEqual([
      "Set up.",
      "$$\na = b\n\nc = d\n$$",
      "```py\nx = 1\n\ny = 2\n```",
      "Done.",
    ]);
    expect(solutionSteps(null)).toEqual([]);
  });
});

describe("generated exercises job", () => {
  async function settled(db: ReturnType<typeof openDatabase>, state: string) {
    for (let i = 0; i < 200; i++) {
      if (exerciseJob(db, { planId: "plan", topicId: "topic" })?.state === state)
        return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      JSON.stringify(exerciseJob(db, { planId: "plan", topicId: "topic" })),
    );
  }

  it("writes grounded exercises once, retries with the current engine and keeps checks anchored", async () => {
    const db = openDatabase(":memory:");
    try {
      db.exec(`
        INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('plan','Analysis','ready',1,1);
        INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('topic','plan','Derivatives',0,1), ('bare','plan','Bare',1,1);
        INSERT INTO sources (id,title,kind,status,created_at,updated_at) VALUES ('source','Notes','txt','ready',1,1);
        INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('doc','source',1,'{}',1);
        INSERT INTO passages (id,source_id,document_id,text,created_at) VALUES ('passage','source','doc','The derivative of x**2 is 2*x.',1);
        INSERT INTO topic_passages (topic_id,passage_id) VALUES ('topic','passage');
      `);
      db.prepare(
        "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
      ).run(JSON.stringify({ provider: "claude", model: "first" }));
      const models: string[] = [];
      let sources = ["missing"];
      const runner = createRunner(db, () => {});
      registerExerciseJobs(db, runner, async (input) => {
        models.push(input.selection.model ?? "");
        const data = {
          exercises: [
            {
              statement: "Differentiate x**2.",
              steps: [
                {
                  text: "Apply the power rule.",
                  latex: "\\frac{d}{dx}x^2",
                  check: { kind: "derivative", expr: "x**2", claimed: "2*x" },
                },
                { text: "Simplify." },
              ],
              finalAnswer: "2x",
              hints: ["Lower the power by one."],
              sources,
            },
          ],
        };
        return {
          text: JSON.stringify(data),
          structured: data,
          provider: "claude",
          model: "reported",
          inputTokens: 1,
        };
      });
      const scope = { planId: "plan", topicId: "topic" };
      expect(() => enqueueExercises(db, runner, { ...scope, topicId: "bare" })).toThrow(
        "exercises-no-sources",
      );

      enqueueExercises(db, runner, scope);
      await settled(db, "failed");
      expect(topicExercises(db, "topic")).toEqual([]);

      sources = ["passage"];
      db.prepare("UPDATE feature_engines SET selection_json = ?").run(
        JSON.stringify({ provider: "claude", model: "second" }),
      );
      enqueueExercises(db, runner, scope);
      await settled(db, "succeeded");
      expect(new Set(models)).toEqual(new Set(["first", "second"]));
      expect(models.at(-1)).toBe("second");

      const rows = topicExercises(db, "topic");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        prompt: "Differentiate x**2.",
        answer: "2x",
        passageId: "passage",
        generated: true,
      });
      const view = exerciseView(rows[0]!);
      expect(view.steps[0]!.text).toContain("$$\n\\frac{d}{dx}x^2\n$$");
      expect(view.steps[0]!.check).toMatchObject({
        kind: "derivative",
        step: "Apply the power rule.",
      });
      expect(view.steps[0]!.text).toContain(view.steps[0]!.check!.step);
      expect(view.hints).toEqual(["Lower the power by one."]);
      expect(
        db
          .prepare(
            "SELECT grounding, engine_provider, prompt_template FROM exercises",
          )
          .get(),
      ).toEqual({
        grounding: "sources",
        engine_provider: "claude",
        prompt_template: "exercise.generate",
      });

      const calls = models.length;
      enqueueExercises(db, runner, scope);
      expect(models).toHaveLength(calls);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'exercise-build'").get(),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe("topicExercises", () => {
  it("returns the book's exercises for that chapter only", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Moti", file: "01.md" },
            { id: "c2", number: 2, title: "Forze", file: "02.md" },
          ],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore.\n",
        "chapters/02.md": "## p1 | Newton\nLa forza.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale il lavoro?\n:::solution\nW = F s.\n:::\n:::\n:::exercise{id="e2" chapter="2"}\nQuanto vale la forza?\n:::solution\nF = ma.\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const topics = db
      .prepare(`SELECT id, title FROM topics WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ id: string; title: string }>;
    const first = topicExercises(db, topics[0]?.id ?? "");
    const second = topicExercises(db, topics[1]?.id ?? "");
    expect(first.map((row) => row.prompt)).toEqual(["Quanto vale il lavoro?"]);
    expect(first[0]?.answer).toContain("W = F");
    const passage = db
      .prepare(`SELECT id FROM passages WHERE source_id = ? AND section_path = '1. Moti'`)
      .get(imported.sourceId) as { id: string };
    expect(first[0]?.passageId).toBe(passage.id);
    expect(second.map((row) => row.prompt)).toEqual(["Quanto vale la forza?"]);
  });

  it("does not cite another book's chapter with the same number", () => {
    const db = openDatabase(":memory:");
    const first = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "a",
          title: "A",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nLibro A.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nDomanda A?\n:::solution\nRisposta A.\n:::\n:::\n',
      }),
    );
    const second = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "b",
          title: "B",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nLibro B.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nDomanda B?\n:::solution\nRisposta B.\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, {
      title: "Due libri",
      sourceIds: [first.sourceId, second.sourceId],
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ? ORDER BY position LIMIT 1`)
      .get(plan.planId) as { id: string };
    const rows = topicExercises(db, topic.id);
    const own = rows.find((row) => row.prompt.startsWith("Domanda A"));
    const ownPassage = db
      .prepare(`SELECT id FROM passages WHERE source_id = ?`)
      .get(first.sourceId) as { id: string };
    expect(own?.passageId).toBe(ownPassage.id);
    expect(rows.some((row) => row.prompt.startsWith("Domanda B"))).toBe(false);
  });
});
