import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { buildGapDrill, readGapDrill } from "./gapDrill";
import { saveQuiz, startAttempt } from "./attempt";
import { gapMisses } from "./gapInsight";
import { mergeGap } from "./gapRows";

const NOW = Date.UTC(2026, 5, 1, 12);

/** The drill makes one call for its short explanation and one per batch of questions; the batch prompt names a count. */
const isExplanation = (prompt: string) => !("count" in (JSON.parse(prompt) as object));
const explanationReply = {
  structured: { explanation: "Velocity has a direction, so it is a vector." },
  text: "{}",
  provider: "claude",
  model: "test-model",
  inputTokens: 1,
};

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
    expect(gapMisses(db, "gap")).toEqual([
      {
        question: "Velocity is a scalar.",
        answer: "",
        expected: "false",
        explanation: "Velocity has a direction, so it is a vector.",
        passageIds: ["p"],
      },
    ]);
    db.prepare("UPDATE gaps SET opened_at = ?").run(NOW + 60_000);
    expect(gapMisses(db, "gap")).toEqual([]);
  });

  it("builds a drill that targets the misses, links it to the gap and starts an attempt", async () => {
    const db = fixture();
    const systems: string[] = [];
    const run: GenerateInput["run"] = async (input) => {
      if (isExplanation(input.prompt)) return explanationReply;
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
    // LES-03: a short explanation and five questions, not ten.
    const stored = JSON.parse(item.body_json) as { questions: unknown[]; explanation: string; config: { count: number } };
    expect(stored.questions).toHaveLength(5);
    expect(stored.config.count).toBe(5);
    expect(stored.explanation).toBe("Velocity has a direction, so it is a vector.");
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

  it("feeds the drill the gap's misconception, the student's wrong answers, the full reference and the cited passages", async () => {
    const db = fixture();
    const explanation = `${"Velocity has a direction, so it is a vector. ".repeat(8)}Speed does not.`;
    db.prepare("UPDATE gaps SET misconception = 'Treats velocity as if it had no direction.', severity = 'severe' WHERE id = 'gap'").run();
    // Another gap on the topic has its own misconception; the drill for 'gap' must not carry it.
    db.prepare(
      "INSERT INTO gaps (id, plan_id, topic_id, opened_at, origin, misconception) VALUES ('other', 'plan', 'topic', ?, 'misconception', 'Confuses speed with displacement.')",
    ).run(NOW + 1);
    db.prepare("UPDATE attempt_answers SET payload_json = ? WHERE id = 'ans'").run(
      JSON.stringify({
        picks: { q1: "true" },
        results: [{ id: "q1", score: 0, expected: "false", explanation }],
      }),
    );
    const prompts: Array<{ system?: string; prompt: string }> = [];
    const run: GenerateInput["run"] = async (input) => {
      prompts.push({ system: input.system, prompt: input.prompt });
      if (isExplanation(input.prompt)) return explanationReply;
      throw new Error("stop after the first batch");
    };
    await expect(buildGapDrill(db, { planId: "plan", topicId: "topic", gapId: "gap" }, run)).rejects.toThrow("stop after");
    const system = prompts[1]!.system ?? "";
    const focus = JSON.parse(system.slice(system.indexOf("Focus data: ") + "Focus data: ".length)) as {
      misconception: string;
      mistakes: Array<Record<string, string>>;
    };
    expect(focus.misconception).toBe("Treats velocity as if it had no direction.");
    expect(JSON.stringify(focus)).not.toContain("Confuses speed");
    expect(focus.mistakes).toEqual([
      { question: "Velocity is a scalar.", studentAnswer: "true", expected: "false", explanation: explanation.trim() },
    ]);
    expect(prompts[1]!.prompt).toContain("Velocity is displacement per time.");
    // The explanation call saw the same focus and passages.
    expect(prompts[0]!.system).toContain("short explanation");
    expect(JSON.parse(prompts[0]!.prompt)).toMatchObject({ topic: "Motion", focus: { misconception: focus.misconception } });
  });

  it("drills the gap it is asked for, and the topic's top gap when none is named", async () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO gaps (id, plan_id, topic_id, opened_at, origin, misconception, severity) VALUES ('other', 'plan', 'topic', ?, 'misconception', 'Confuses speed with displacement.', 'severe')",
    ).run(NOW + 1);
    const focusFor = async (gapId?: string) => {
      let focus = "";
      const run: GenerateInput["run"] = async (input) => {
        if (isExplanation(input.prompt)) return explanationReply;
        focus = input.system ?? "";
        throw new Error("stop");
      };
      await expect(buildGapDrill(db, { planId: "plan", topicId: "topic", gapId }, run)).rejects.toThrow("stop");
      return focus;
    };
    expect(await focusFor("gap")).not.toContain("Confuses speed");
    expect(await focusFor("other")).toContain("Confuses speed with displacement.");
    // No gap named: the severe one leads.
    expect(await focusFor()).toContain("Confuses speed with displacement.");
    await expect(buildGapDrill(db, { planId: "plan", topicId: "topic", gapId: "nope" })).rejects.toThrow("gap-missing");
  });

  it("resumes saved questions after interruption without another model call", async () => {
    const db = fixture();
    let calls = 0;
    let saved: Parameters<typeof buildGapDrill>[1] | undefined;
    let explained = 0;
    const run: GenerateInput["run"] = async (input) => {
      if (isExplanation(input.prompt)) {
        explained++;
        return explanationReply;
      }
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
      if (params.snapshot?.questions.length === 5) throw new DOMException("Interrupted", "AbortError");
    })).rejects.toThrow("Interrupted");
    expect(saved?.snapshot?.questions).toHaveLength(5);
    expect(saved?.snapshot?.explanation).toBe("Velocity has a direction, so it is a vector.");
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "claude", model: "changed" }));
    const attemptId = await buildGapDrill(db, saved!, run);
    expect(attemptId).toBeTruthy();
    expect(calls).toBe(1);
    // The saved explanation is reused too.
    expect(explained).toBe(1);
    db.close();
  });

  it("saves nothing when the gap closes while the model writes", async () => {
    const db = fixture();
    const run: GenerateInput["run"] = async (input) => {
      if (isExplanation(input.prompt)) return explanationReply;
      db.prepare("UPDATE gaps SET closed_at = ?").run(NOW + 1);
      const { count, questionKinds } = JSON.parse(input.prompt) as { count: number; questionKinds: string[] };
      const structured = {
        questions: Array.from({ length: count }, (_, i) => ({
          kind: questionKinds[i],
          stem: `Late ${i}${questionKinds[i] === "completion" ? " {{1}}" : ""}`,
          explanation: "x",
          passageIds: ["p"],
          ...(questionKinds[i] === "mcq"
            ? { options: ["vector", "scalar", "unit", "distance"], correct: 0 }
            : questionKinds[i] === "completion"
              ? { accepted: ["vector"] }
              : { correct: false }),
        })),
      };
      return { structured, text: "{}", provider: "claude", model: "m", inputTokens: 1 };
    };
    await expect(buildGapDrill(db, { planId: "plan", topicId: "topic" }, run)).rejects.toThrow("gap-missing");
    expect(db.prepare("SELECT count(*) AS n FROM gap_items").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM attempts WHERE id != 'att'").get()).toEqual({ n: 0 });
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

describe("a drill built for a gap that later merged", () => {
  const job = (db: ReturnType<typeof fixture>, id: string, gapId: string, at: number) => {
    const itemId = saveQuiz(db, "plan", [{ id: `q-${id}`, stem: "Motion", grade: { kind: "tf", picked: false, correct: true } }]);
    const { attemptId } = startAttempt(db, "plan", itemId);
    db.prepare("INSERT INTO jobs (id, kind, state, params_json, created_at, updated_at) VALUES (?, 'gap-drill', 'succeeded', ?, ?, ?)").run(
      id,
      JSON.stringify({ planId: "plan", topicId: "topic", gapId, itemId, attemptId }),
      at,
      at,
    );
    db.prepare("INSERT INTO gap_items (gap_id, item_id) VALUES (?, ?)").run(gapId, itemId);
    return { itemId, attemptId };
  };

  it("is still offered for the gap that absorbed it, and an unrelated gap's drill is not", () => {
    const db = fixture();
    db.prepare("INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('other', 'plan', 'topic', ?)").run(NOW + 1);
    db.prepare("INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('into', 'plan', 'topic', ?)").run(NOW + 2);
    const built = job(db, "drill-for-gap", "gap", NOW + 100);
    job(db, "drill-for-other", "other", NOW + 200);
    expect(readGapDrill(db, "plan", "topic", "into")).toBeNull();
    mergeGap(db, "gap", "into", NOW + 300);
    expect(readGapDrill(db, "plan", "topic", "into")).toEqual({ jobId: "drill-for-gap", state: "succeeded", attemptId: built.attemptId });
    // The drill's quiz moved with the answers, so its attempt counts for the surviving gap.
    expect(db.prepare("SELECT gap_id FROM gap_items WHERE item_id = ?").get(built.itemId)).toEqual({ gap_id: "into" });
    // A gap that closed by learning hands nothing on.
    db.prepare("UPDATE gaps SET closed_at = ? WHERE id = 'other'").run(NOW + 400);
    expect(readGapDrill(db, "plan", "topic", "into")?.jobId).toBe("drill-for-gap");
    expect(readGapDrill(db, "plan", "topic", "other")).toBeNull();
    // Once taken, it is not offered again.
    db.prepare("UPDATE attempts SET submitted_at = ? WHERE id = ?").run(NOW + 500, built.attemptId);
    expect(readGapDrill(db, "plan", "topic", "into")).toBeNull();
    db.close();
  });

  it("is saved under the surviving gap when its own gap merged while the model wrote", async () => {
    const db = fixture();
    db.prepare("INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('into', 'plan', 'topic', ?)").run(NOW + 2);
    const run: GenerateInput["run"] = async (input) => {
      if (isExplanation(input.prompt)) return explanationReply;
      mergeGap(db, "gap", "into", NOW + 300);
      const { count, questionKinds } = JSON.parse(input.prompt) as { count: number; questionKinds: string[] };
      const structured = {
        questions: Array.from({ length: count }, (_, i) => ({
          kind: questionKinds[i],
          stem: `Merged ${i}${questionKinds[i] === "completion" ? " {{1}}" : ""}`,
          explanation: "x",
          passageIds: ["p"],
          ...(questionKinds[i] === "mcq"
            ? { options: ["vector", "scalar", "unit", "distance"], correct: 0 }
            : questionKinds[i] === "completion"
              ? { accepted: ["vector"] }
              : { correct: false }),
        })),
      };
      return { structured, text: "{}", provider: "claude", model: "m", inputTokens: 1 };
    };
    let saved: { gapId?: string } = {};
    await buildGapDrill(db, { planId: "plan", topicId: "topic", gapId: "gap" }, run, undefined, (params) => (saved = params));
    expect(db.prepare("SELECT gap_id FROM gap_items").all()).toEqual([{ gap_id: "into" }]);
    expect(saved.gapId).toBe("into");
    db.close();
  });
});
