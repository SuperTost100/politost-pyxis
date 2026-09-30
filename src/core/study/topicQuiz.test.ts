import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { completeNode, createPlan, deletePlan, readPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { studyHandlers } from "./handlers";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("diagnostic", () => {
  it("grades the book and finishes the diagnostic node", () => {
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
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const intro = readPlan(db, plan.planId)?.nodes.find((node) => node.kind === "diagnostic");
    const introNode = readPlan(db, plan.planId)?.nodes.find((node) => node.kind === "intro");
    completeNode(db, plan.planId, introNode?.id ?? "");
    const study = studyHandlers(db);
    const started = study.diagnosticStart({ planId: plan.planId });
    const question = started.questions[0];
    study.quizSubmit({
      attemptId: started.attemptId,
      picks: { [question?.id ?? ""]: "10 N" },
    });
    const after = readPlan(db, plan.planId);
    expect(after?.nodes.find((node) => node.id === intro?.id)?.state).toBe("done");
    const event = db
      .prepare(`SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given'`)
      .get() as { topic_id: string; payload_json: string };
    expect(event.topic_id).toBeTruthy();
    expect(JSON.parse(event.payload_json).score).toBe(1);
    expect(() => deletePlan(db, plan.planId)).not.toThrow();
    expect(readPlan(db, plan.planId)).toBeNull();
  });
});
