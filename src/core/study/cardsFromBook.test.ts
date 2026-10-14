import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { templateVersion } from "../engine/prompts";
import { seedCards } from "./cards";
import { generateTopicCards, readCardsBuild } from "./cardsFromBook";
import { studyHandlers } from "./handlers";

const passages = [
  ["p1", "Velocity is the displacement of a body per unit of time."],
  ["p2", "Acceleration is the rate at which velocity changes over time."],
] as const;

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
  passages.forEach(([id, text], i) => {
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES (?, 'src', 'doc', ?, ?)",
    ).run(id, text, i + 1);
    db.prepare(
      "INSERT INTO topic_passages (topic_id, passage_id) VALUES ('topic', ?)",
    ).run(id);
  });
  return db;
}

function counting() {
  const calls: Array<{ system?: string }> = [];
  const run: GenerateInput["run"] = async (input) => {
    calls.push({ system: input.system });
    const { passages: batch } = JSON.parse(input.prompt) as {
      passages: Array<{ id: string }>;
    };
    const structured = {
      cards: batch.flatMap((row, i) => [
        {
          kind: "qa",
          front: `What does passage ${row.id} define?`,
          back: "A quantity of motion.",
          passageId: row.id,
        },
        i === 0
          ? {
              kind: "cloze",
              text: "{{c1::Velocity}} is displacement per unit of time.",
              extra: "A vector quantity.",
              passageId: row.id,
            }
          : {
              kind: "concept",
              term: "Acceleration",
              definition: "Rate of change of velocity.",
              passageId: row.id,
            },
      ]),
    };
    return {
      structured,
      text: JSON.stringify(structured),
      provider: "claude",
      model: "test-model",
      inputTokens: 1,
    };
  };
  return { calls, run };
}

it("uses the persisted engine when settings change before an interrupted build resumes", async () => {
  const db = fixture();
  const selection = { provider: "claude" as const, model: "saved-model" };
  db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "claude", model: "new-model" }));
  const mock = counting();
  let model: string | undefined;
  await generateTopicCards(db, { planId: "plan", topicId: "topic", selection }, async (input) => {
    model = input.selection.model;
    return mock.run(input);
  });
  expect(model).toBe("saved-model");
  db.close();
});

describe("generated topic cards", () => {
  it("stores grounded question, concept and cloze cards with provenance, once", async () => {
    const db = fixture();
    const { calls, run } = counting();
    await generateTopicCards(db, { planId: "plan", topicId: "topic" }, run);
    const rows = db
      .prepare(
        "SELECT front, back, passage_id, model_id, prompt_template, prompt_version, grounding FROM cards ORDER BY front",
      )
      .all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => /\{\{c1::Velocity\}\}/.test(row.front!))).toBe(
      true,
    );
    for (const row of rows) {
      expect(row.passage_id).toMatch(/^p[12]$/);
      expect(row.model_id).toBe("test-model");
      expect(row.prompt_template).toBe("cards.generate");
      expect(row.prompt_version).toBe(templateVersion("cards.generate"));
      if (row.front !== "Acceleration")
        expect(passages.some(([, text]) => text.startsWith(row.front!))).toBe(
          false,
        );
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("Write all output in Italian.");
    await generateTopicCards(db, { planId: "plan", topicId: "topic" }, run);
    expect(calls).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({
      n: 4,
    });
  });

  it("replaces unstudied prefix cards and keeps studied ones", async () => {
    const db = fixture();
    const [first, second] = passages;
    const [oldIdle] = seedCards(db, {
      planId: "plan",
      topicId: "topic",
      pairs: [{ front: "Motion · 1", back: first[1], passageId: first[0] }],
    });
    const [oldStudied] = seedCards(db, {
      planId: "plan",
      topicId: "topic",
      pairs: [{ front: "Motion · 2", back: second[1], passageId: second[0] }],
    });
    db.prepare(
      "INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('r', ?, 'good', '{}', 1)",
    ).run(oldStudied);
    await generateTopicCards(
      db,
      { planId: "plan", topicId: "topic" },
      counting().run,
    );
    const removed = (id: string | undefined) =>
      (
        db.prepare("SELECT removed FROM cards WHERE id = ?").get(id) as {
          removed: number;
        }
      ).removed;
    expect(removed(oldIdle)).toBe(1);
    expect(removed(oldStudied)).toBe(0);
  });

  it("never turns an exercise into a card", async () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO exercises (id, prompt, answer, locator_json, created_at) VALUES ('ex', 'Determinare il dominio di f(x)=sqrt(ln(x+2))/(x-1).', 'x>-1, x!=0', ?, 1)",
    ).run(JSON.stringify({ kind: "generated", topicId: "topic" }));
    await studyHandlers(db, undefined, counting().run).cardsGenerate({
      planId: "plan",
      topicId: "topic",
    });
    const fronts = db.prepare("SELECT front FROM cards").all() as Array<{ front: string }>;
    expect(fronts).toHaveLength(4);
    expect(fronts.some((row) => /dominio/.test(row.front))).toBe(false);
    db.close();
  });

  it("never generates from a read", () => {
    const db = fixture();
    const handlers = studyHandlers(db, undefined, async () => {
      throw new Error("model called");
    });
    expect(handlers.cards({ planId: "plan", topicId: "topic" })).toEqual([]);
    expect(handlers.queue({ planId: "plan", topicId: "topic" })).toEqual({
      fresh: 0,
      learning: 0,
      mastered: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({
      n: 0,
    });
    expect(readCardsBuild(db, { planId: "plan", topicId: "topic" })).toBeNull();
  });
});

it("covers every passage in successive bounded batches without a 20-passage ceiling", async () => {
  const db = fixture();
  for (let i = 0; i < 22; i++) {
    const id = `extra-${i}`;
    db.prepare("INSERT INTO passages(id,text,created_at) VALUES(?,?,1)").run(
      id,
      `Concept ${i} explains a distinct part of the topic in enough detail for a grounded question.`,
    );
    db.prepare(
      "INSERT INTO topic_passages(topic_id,passage_id) VALUES('topic',?)",
    ).run(id);
  }
  let calls = 0;
  await generateTopicCards(
    db,
    { planId: "plan", topicId: "topic" },
    async (input) => {
      calls++;
      const payload = JSON.parse(input.prompt) as {
        passages: { id: string; text: string }[];
      };
      expect(payload.passages.length).toBeLessThanOrEqual(5);
      const structured = {
        cards: payload.passages.map((p) => ({
          kind: "qa",
          front: `Which idea belongs to ${p.id}?`,
          back: "The grounded concept.",
          passageId: p.id,
        })),
      };
      return {
        structured,
        text: JSON.stringify(structured),
        provider: "claude",
        model: "fixture",
        inputTokens: 1,
      };
    },
  );
  expect(calls).toBe(5);
  expect(
    db
      .prepare(
        "SELECT count(DISTINCT passage_id) AS n FROM cards WHERE prompt_template='cards.generate'",
      )
      .get(),
  ).toEqual({ n: 24 });
  db.close();
});

describe("one fact per card", () => {
  const good = (id: string) => ({
    kind: "qa",
    front: "Che cosa misura la velocità?",
    back: "Lo spostamento per unità di tempo.",
    passageId: id,
  });
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. passo ${i}`).join("\n");
  const bad: Record<string, Record<string, unknown>> = {
    "a front over 200 characters": { front: `Determinare il dominio ${"x".repeat(200)}` },
    "a back over 300 characters": { back: "y".repeat(301) },
    "a back with two paragraphs": { back: "Primo passo.\n\nSecondo passo." },
    "a back with numbered steps": { back: lines(2) },
    "a back with three lines": { back: "a\nb\nc" },
    "a derivation in display math": { back: "Poniamo $$x+2>0$$ e poi risolviamo." },
    "a front with a display block": { front: "Calcola $$\\int_0^1 x\\,dx$$" },
  };

  async function run(first: Record<string, unknown> | null, repeats: number) {
    const db = fixture();
    db.prepare("DELETE FROM topic_passages WHERE passage_id = 'p2'").run();
    let calls = 0;
    const outcome = await generateTopicCards(db, { planId: "plan", topicId: "topic" }, async () => {
      calls += 1;
      const structured = {
        cards: [calls <= repeats && first ? { ...good("p1"), ...first } : good("p1")],
      };
      return { structured, text: JSON.stringify(structured), provider: "claude", model: "m", inputTokens: 1 };
    }).then(
      () => "ok",
      (error: { code?: string }) => error.code ?? "failed",
    );
    const n = (db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n;
    db.close();
    return { outcome, calls, n };
  }

  for (const [name, patch] of Object.entries(bad))
    it(`asks again when a card has ${name}`, async () => {
      expect(await run(patch, 1)).toEqual({ outcome: "ok", calls: 2, n: 1 });
    });

  it("fails visibly, without a silent empty topic, when every answer is rejected", async () => {
    const result = await run(bad["a back with two paragraphs"]!, 9);
    expect(result).toEqual({ outcome: "invalid-output", calls: 3, n: 0 });
  });

  it("accepts a short card with inline math and a cloze", async () => {
    const db = fixture();
    db.prepare("DELETE FROM topic_passages WHERE passage_id = 'p2'").run();
    const structured = {
      cards: [
        { ...good("p1"), front: "Quanto vale $e^{i\\pi}$?", back: "$-1$" },
        { kind: "cloze", text: "{{c1::Velocità}} è lo spostamento per unità di tempo.", extra: "Grandezza vettoriale.", passageId: "p1" },
      ],
    };
    await generateTopicCards(db, { planId: "plan", topicId: "topic" }, async () => ({
      structured, text: "", provider: "claude", model: "m", inputTokens: 1,
    }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 2 });
    db.close();
  });
});
