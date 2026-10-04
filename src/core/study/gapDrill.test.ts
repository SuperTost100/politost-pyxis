import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { buildGapDrill, readGapDrill } from "./gapDrill";
import { saveQuiz, startAttempt } from "./attempt";
import { gapMisses } from "./gapInsight";

const NOW = Date.UTC(2026, 5, 1, 12);

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
  db.prepare(
    "INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('gap', 'plan', 'topic', ?)",
  ).run(NOW);
  const body = {
    config: { count: 10, types: ["mcq"], feedback: true },
    complete: true,
    questions: [
      {
        id: "q1",
        stem: "Velocity is a scalar.",
        sourceIds: ["p"],
        answer: { kind: "tf" },
      },
      {
        id: "q2",
        stem: "Speed equals velocity.",
        sourceIds: ["p"],
        answer: { kind: "tf" },
      },
    ],
  };
  db.prepare(
    "INSERT INTO items (id, plan_id, topic_id, kind, body_json, grounding, created_at) VALUES ('item', 'plan', 'topic', 'quiz', ?, 'sources', 1)",
  ).run(JSON.stringify(body));
  db.prepare(
    "INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('att', 'plan', 'item', ?, ?)",
  ).run(NOW - 1000, NOW - 5);
  db.prepare(
    "INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('ans', 'att', ?, ?)",
  ).run(
    JSON.stringify({
      score: 0,
      results: [
        {
          id: "q1",
          score: 0,
          expected: "false",
          explanation:
            "Velocity has a direction, so it is a vector. Speed does not.",
        },
        { id: "q2", score: 1, expected: "false", explanation: "" },
      ],
    }),
    NOW - 5,
  );
  return db;
}

describe("knowledge gap misconceptions and drill", () => {
  it("summarises the wrong answers since the gap opened", () => {
    const db = fixture();
    expect(gapMisses(db, "plan", "topic", NOW)).toEqual([
      {
        question: "Velocity is a scalar.",
        expected: "false",
        explanation: "Velocity has a direction, so it is a vector.",
        passageIds: ["p"],
      },
    ]);
    expect(gapMisses(db, "plan", "topic", NOW + 60_000)).toEqual([]);
  });

  it("builds a drill that targets the misses, links it to the gap and starts an attempt", async () => {
    const db = fixture();
    const systems: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      systems.push(input.system ?? "");
      const { count, questionKinds } = JSON.parse(input.prompt) as {
        count: number;
        questionKinds: string[];
      };
      const structured = {
        questions: Array.from({ length: count }, (_, i) => ({
          kind: questionKinds[i],
          stem: `Drill statement ${systems.length}-${i}${questionKinds[i] === "completion" ? " {{1}}" : ""}`,
          explanation: "A vector has a direction.",
          passageIds: ["p"],
          ...(questionKinds[i] === "mcq"
            ? { options: ["vector", "scalar", "unit", "distance"], correct: 0 }
            : questionKinds[i] === "completion"
              ? { accepted: ["vector"] }
              : { correct: false }),
        })),
      };
      return {
        structured,
        text: JSON.stringify(structured),
        provider: "claude",
        model: "test-model",
        inputTokens: 1,
      };
    };
    let saved: unknown;
    const attemptId = await buildGapDrill(
      db,
      { planId: "plan", topicId: "topic" },
      run,
      undefined,
      (params) => (saved = params),
    );
    expect(systems.every((system) => system.includes("targeted drill"))).toBe(
      true,
    );
    expect(systems[0]).toContain("Velocity is a scalar.");
    const item = db
      .prepare(
        "SELECT i.id, i.prompt_template, i.body_json FROM gap_items g JOIN items i ON i.id = g.item_id WHERE g.gap_id = 'gap'",
      )
      .get() as { id: string; prompt_template: string; body_json: string };
    expect(item.prompt_template).toBe("gap.drill");
    expect(JSON.parse(item.body_json).questions).toHaveLength(10);
    expect(saved).toMatchObject({ itemId: item.id, attemptId });
    expect(
      db.prepare("SELECT item_id FROM attempts WHERE id = ?").get(attemptId),
    ).toEqual({ item_id: item.id });
    // Rebuilding after a resume reuses the saved attempt instead of generating again.
    expect(
      await buildGapDrill(
        db,
        { planId: "plan", topicId: "topic", attemptId },
        run,
      ),
    ).toBe(attemptId);
    expect(readGapDrill(db, "plan", "topic")).toBeNull();
  });

  it("resumes saved questions after interruption without another model call", async () => {
    const db = fixture();
    let calls = 0;
    let saved: Parameters<typeof buildGapDrill>[1] | undefined;
    const run: GenerateInput["run"] = async (input) => {
      calls++;
      const { count, questionKinds } = JSON.parse(input.prompt);
      const structured = { questions: Array.from({ length: count }, (_, i) => ({
        kind: questionKinds[i],
        stem: `Saved ${i}${questionKinds[i] === "completion" ? " {{1}}" : ""}`,
        explanation: "Velocity is a vector.", passageIds: ["p"],
        ...(questionKinds[i] === "mcq" ? { options: ["vector", "scalar", "unit", "distance"], correct: 0 } : questionKinds[i] === "completion" ? { accepted: ["vector"] } : { correct: false }),
      })) };
      return { structured, text: JSON.stringify(structured), provider: "claude", model: "original", inputTokens: 1 };
    };
    await expect(buildGapDrill(db, { planId: "plan", topicId: "topic" }, run, undefined, (params) => {
      saved = structuredClone(params);
      if (params.snapshot?.questions.length === 10) throw new DOMException("Interrupted", "AbortError");
    })).rejects.toThrow("Interrupted");
    expect(saved?.snapshot?.questions).toHaveLength(10);
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "claude", model: "changed" }));
    const attemptId = await buildGapDrill(db, saved!, run);
    expect(attemptId).toBeTruthy();
    expect(calls).toBe(1);
    db.close();
  });

  it("refuses a drill when the gap is closed", async () => {
    const db = fixture();
    db.prepare("UPDATE gaps SET closed_at = ?").run(NOW + 1);
    await expect(
      buildGapDrill(db, { planId: "plan", topicId: "topic" }),
    ).rejects.toThrow("gap-missing");
  });
});

it("does not offer an untaken drill for a closed gap when a new gap opens", () => {
  const db = fixture(); const itemId = saveQuiz(db, "plan", [{ id: "q", stem: "Motion", grade: { kind: "tf", picked: false, correct: true } }]);
  const { attemptId } = startAttempt(db, "plan", itemId);
  db.prepare("INSERT INTO jobs (id, kind, state, params_json, created_at, updated_at) VALUES ('old-drill', 'gap-drill', 'succeeded', ?, ?, ?)").run(JSON.stringify({ planId: "plan", topicId: "topic", gapId: "gap", itemId, attemptId }), NOW + 100, NOW + 100);
  expect(readGapDrill(db, "plan", "topic")?.jobId).toBe("old-drill");
  db.prepare("UPDATE gaps SET closed_at = ? WHERE id = 'gap'").run(NOW + 200);
  db.prepare("INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('new-gap', 'plan', 'topic', ?)").run(NOW + 300);
  expect(readGapDrill(db, "plan", "topic")).toBeNull(); db.close();
});
