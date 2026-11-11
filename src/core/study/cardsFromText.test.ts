import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { templateVersion } from "../engine/prompts";
import { deckDueCards, dueCards } from "./cards";
import {
  cardPlaces,
  proposeCards,
  saveProposedCards,
  type ProposedCard,
} from "./cardsFromText";

function fixture() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  run(
    "INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Physics', 1), ('chem', 'Chemistry', 1)",
  );
  run(
    "INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Mechanics', 'ready', 1, 2), ('opt', 'phys', 'Optics', 'ready', 1, 1), ('org', 'chem', 'Organic', 'ready', 1, 3)",
  );
  run(
    `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES
     ('kin', 'mech', 'Kinematics', 0, 1), ('dyn', 'mech', 'Dynamics', 1, 1),
     ('lens', 'opt', 'Lenses', 0, 1), ('alk', 'org', 'Alkanes', 0, 1)`,
  );
  run(
    "INSERT INTO topics (id, plan_id, title, position, created_at, archived_at) VALUES ('old', 'mech', 'Archived', 2, 1, 5)",
  );
  run(
    "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('src', 'pdf', 'Notes', 'ready', 1, 1)",
  );
  run(
    "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'src', 1, '{}', 1)",
  );
  const passages = {
    p1: "Velocity is the displacement of a body per unit of time.",
    p2: "Acceleration is the rate at which velocity changes over time.",
    p3: "Newton's second law states that force equals mass times acceleration.",
  };
  Object.entries(passages).forEach(([id, text], i) =>
    run(
      "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES (?, 'src', 'doc', ?, ?)",
      id,
      text,
      i + 1,
    ),
  );
  run(
    "INSERT INTO topic_passages (topic_id, passage_id) VALUES ('kin', 'p1'), ('kin', 'p2'), ('dyn', 'p3')",
  );
  return db;
}

type Request = { text: string; passages: Array<{ id: string; text: string }> };

/** A recorded reply: what the model returns for the request it was given. */
function recorded(cards: unknown[]) {
  const seen: Array<{ system?: string; request: Request }> = [];
  const run: GenerateInput["run"] = async (input) => {
    seen.push({
      system: input.system,
      request: JSON.parse(input.prompt) as Request,
    });
    const structured = { cards };
    return {
      structured,
      text: JSON.stringify(structured),
      provider: "claude",
      model: "test-model",
      inputTokens: 1,
    };
  };
  return { seen, run };
}

const reply = [
  {
    kind: "qa",
    front: "What is velocity?",
    back: "Displacement per unit of time.",
    passageId: "p1",
  },
  {
    kind: "cloze",
    text: "{{c1::Acceleration}} is the rate of change of velocity.",
    extra: "A vector.",
    passageId: "p2",
  },
  {
    kind: "concept",
    term: "Inertia",
    definition: "Resistance to a change of motion.",
    passageId: null,
  },
];

describe("cards proposed from a text", () => {
  it("writes in the profile's language when no exam is chosen", async () => {
    const db = fixture();
    db.prepare("UPDATE plans SET content_language = 'en' WHERE id = 'mech'").run();
    const { seen, run } = recorded(reply.map((card) => ({ ...card, passageId: null })));
    await proposeCards(db, { planId: "mech", topicId: "kin", text: "Velocity is a rate.", passageIds: [] }, run);
    await proposeCards(db, { text: "Velocity is a rate.", passageIds: [] }, run);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.system).toContain("Write all output in English.");
    expect(seen[1]!.system).toContain("Write all output in Italian.");
    db.close();
  });

  it("sends the text and its passages, returns the cards and stores nothing", async () => {
    const db = fixture();
    const { seen, run } = recorded(reply);
    const out = await proposeCards(
      db,
      {
        planId: "mech",
        topicId: "kin",
        text: "  Velocity is a rate.\n\nAcceleration changes it.  ",
        passageIds: ["p2", "p1", "missing"],
      },
      run,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toContain("Write all output in Italian.");
    expect(seen[0]!.request.text).toBe(
      "Velocity is a rate.\n\nAcceleration changes it.",
    );
    expect(seen[0]!.request.passages.map((row) => row.id)).toEqual([
      "p2",
      "p1",
    ]);
    expect(out.provider).toBe("claude");
    expect(out.model).toBe("test-model");
    expect(out.cards).toEqual([
      {
        front: "What is velocity?",
        back: "Displacement per unit of time.",
        passageId: "p1",
        source: { title: "Notes", page: null },
      },
      {
        front: "{{c1::Acceleration}} is the rate of change of velocity.",
        back: "A vector.",
        passageId: "p2",
        source: { title: "Notes", page: null },
      },
      {
        front: "Inertia",
        back: "Resistance to a change of motion.",
        passageId: null,
        source: null,
      },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({
      n: 0,
    });
    db.close();
  });

  it("runs on the cards engine, not the lesson's or the default one", async () => {
    const db = fixture();
    const row = (feature: string, model: string) =>
      db
        .prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)")
        .run(feature, JSON.stringify({ provider: "claude", model }));
    row("lesson", "lesson-model");
    row("cards", "fast-model");
    const models: string[] = [];
    const { run } = recorded(reply);
    await proposeCards(
      db,
      { planId: "mech", topicId: "kin", text: "Velocity is a rate.\n\nAcceleration changes it.", passageIds: ["p2", "p1"] },
      async (input) => {
        models.push(input.selection.model);
        return run(input);
      },
    );
    expect(models).toEqual(["fast-model"]);
    db.close();
  });

  it("sends only the four passages closest to the text when many are cited", async () => {
    const db = fixture();
    for (let i = 0; i < 6; i += 1)
      db.prepare(
        "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES (?, 'src', 'doc', ?, 9)",
      ).run(`x${i}`, `Unrelated filler number ${i} about nothing`);
    const { seen, run } = recorded([
      {
        kind: "qa",
        front: "What is velocity?",
        back: "A rate.",
        passageId: "p1",
      },
    ]);
    await proposeCards(
      db,
      {
        planId: "mech",
        topicId: "kin",
        text: "Velocity is displacement per unit of time",
        passageIds: ["x0", "x1", "x2", "x3", "x4", "x5", "p3", "p1"],
      },
      run,
    );
    expect(seen[0]!.request.passages.map((row) => row.id)).toEqual(["p1"]);
    db.close();
  });

  it("falls back to the first cited passages when the text shares no word with any of them", async () => {
    const db = fixture();
    for (let i = 0; i < 6; i += 1)
      db.prepare(
        "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES (?, 'src', 'doc', ?, 9)",
      ).run(`x${i}`, `Unrelated filler number ${i} about nothing`);
    const { seen, run } = recorded([
      { kind: "qa", front: "What is v?", back: "A rate.", passageId: "x1" },
    ]);
    const result = await proposeCards(
      db,
      {
        planId: "mech",
        topicId: "kin",
        text: "v = d/t",
        passageIds: ["x0", "x1", "x2", "x3", "x4", "x5", "p3", "p1"],
      },
      run,
    );
    expect(seen[0]!.request.passages.map((row) => row.id)).toEqual([
      "x0",
      "x1",
      "x2",
      "x3",
    ]);
    expect(result.cards[0]!.passageId).toBe("x1");
    db.close();
  });

  it.each([
    [
      "a card linked to a passage that was not sent",
      [{ kind: "qa", front: "Q?", back: "A.", passageId: "p3" }],
    ],
    [
      "a cloze without a deletion",
      [
        {
          kind: "cloze",
          text: "Velocity is a rate.",
          extra: "Note.",
          passageId: null,
        },
      ],
    ],
    [
      "a worked derivation",
      [
        {
          kind: "qa",
          front: "Derive v.",
          back: "First step\n\nSecond step",
          passageId: null,
        },
      ],
    ],
    [
      "a repeated front",
      [
        {
          kind: "qa",
          front: "What is velocity?",
          back: "A rate.",
          passageId: null,
        },
        {
          kind: "qa",
          front: "what is  velocity?",
          back: "Another.",
          passageId: null,
        },
      ],
    ],
    ["no cards", []],
  ])("rejects %s", async (_name, cards) => {
    const db = fixture();
    const { run } = recorded(cards);
    await expect(
      proposeCards(
        db,
        {
          planId: "mech",
          topicId: "kin",
          text: "Velocity is a rate.",
          passageIds: ["p1"],
        },
        run,
      ),
    ).rejects.toThrow();
    db.close();
  });

  it("refuses a topic of another plan and an empty text", async () => {
    const db = fixture();
    const { run } = recorded(reply);
    await expect(
      proposeCards(
        db,
        { planId: "opt", topicId: "kin", text: "x", passageIds: [] },
        run,
      ),
    ).rejects.toThrow("topic-missing");
    await expect(
      proposeCards(
        db,
        { planId: "mech", topicId: "kin", text: "  ", passageIds: [] },
        run,
      ),
    ).rejects.toThrow("card-blank");
    db.close();
  });
});

describe("saving the reviewed cards", () => {
  const kept: ProposedCard[] = [
    {
      front: "What is velocity?",
      back: "Displacement per unit of time.",
      passageId: "p1",
    },
    {
      front: "Inertia",
      back: "Resistance to a change of motion.",
      passageId: null,
    },
  ];
  const save = (db: ReturnType<typeof fixture>, cards = kept) =>
    saveProposedCards(db, {
      planId: "mech",
      topicId: "kin",
      cards,
      provider: "claude",
      model: "test-model",
    });

  it("files them in the topic with their source link, and they are due like any new card", () => {
    const db = fixture();
    expect(save(db)).toEqual({ saved: 2, skipped: 0 });
    const rows = db
      .prepare(
        "SELECT front, passage_id, grounding, engine_provider, model_id, prompt_template, prompt_version FROM cards ORDER BY front",
      )
      .all();
    const version = templateVersion("cards.text");
    expect(rows).toEqual([
      {
        front: "Inertia",
        passage_id: null,
        grounding: "general",
        engine_provider: "claude",
        model_id: "test-model",
        prompt_template: "cards.text",
        prompt_version: version,
      },
      {
        front: "What is velocity?",
        passage_id: "p1",
        grounding: "sources",
        engine_provider: "claude",
        model_id: "test-model",
        prompt_template: "cards.text",
        prompt_version: version,
      },
    ]);
    const due = dueCards(db, "mech", Date.now() + 1, "kin");
    expect(due.map((card) => card.front).sort()).toEqual([
      "Inertia",
      "What is velocity?",
    ]);
    expect(due.find((card) => card.passageId === "p1")?.sourceId).toBe("src");
    expect(due.every((card) => card.state.intervalDays === 0)).toBe(true);
    db.close();
  });

  it("skips a front the topic already has, so saving twice adds nothing", () => {
    const db = fixture();
    save(db);
    expect(save(db)).toEqual({ saved: 0, skipped: 2 });
    expect(
      save(db, [{ front: " What is velocity? ", back: "x", passageId: null }]),
    ).toEqual({ saved: 0, skipped: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({
      n: 2,
    });
    db.close();
  });

  it("treats a front that differs only in case or spacing as already there", () => {
    const db = fixture();
    save(db);
    expect(
      save(db, [
        { front: "WHAT IS  velocity?", back: "x", passageId: null },
        { front: "Fresh fact", back: "y", passageId: null },
        { front: "fresh   FACT", back: "z", passageId: null },
      ]),
    ).toEqual({ saved: 1, skipped: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({
      n: 3,
    });
    db.close();
  });

  it("keeps a removed card from blocking the same front, drops an unknown passage, and rejects a blank face", () => {
    const db = fixture();
    save(db);
    db.prepare("UPDATE cards SET removed = 1").run();
    expect(
      save(db, [{ front: "Inertia", back: "Again.", passageId: "gone" }]),
    ).toEqual({ saved: 1, skipped: 0 });
    expect(
      db.prepare("SELECT passage_id FROM cards WHERE removed = 0").get(),
    ).toEqual({ passage_id: null });
    expect(() =>
      save(db, [{ front: "Q?", back: "  ", passageId: null }]),
    ).toThrow("card-blank");
    expect(() =>
      saveProposedCards(db, {
        planId: "opt",
        topicId: "kin",
        cards: kept,
        provider: "p",
        model: "m",
      }),
    ).toThrow("topic-missing");
    db.close();
  });

  it("files them under a subject with no exam, due in that subject's own review, and skips fronts it already has", () => {
    const db = fixture();
    // A front the exam's topic has does not block the same front among the subject's cards with no exam.
    save(db);
    const loose = (cards = kept) =>
      saveProposedCards(db, { subjectId: "phys", cards, provider: "claude", model: "test-model" });
    expect(loose()).toEqual({ saved: 2, skipped: 0 });
    expect(loose([{ front: "inertia ", back: "x", passageId: null }])).toEqual({ saved: 0, skipped: 1 });
    expect(
      db
        .prepare("SELECT front, plan_id, topic_id, subject_id, grounding FROM cards WHERE plan_id IS NULL ORDER BY front")
        .all(),
    ).toEqual([
      { front: "Inertia", plan_id: null, topic_id: null, subject_id: "phys", grounding: "general" },
      { front: "What is velocity?", plan_id: null, topic_id: null, subject_id: "phys", grounding: "sources" },
    ]);
    const due = deckDueCards(db, { subjectId: "phys" }, Date.now() + 1);
    expect(due.map((card) => card.front).sort()).toEqual(["Inertia", "What is velocity?"]);
    expect(due.find((card) => card.passageId === "p1")?.sourceId).toBe("src");
    // The exam's own deck is unchanged: the cards with no exam are not its.
    expect(dueCards(db, "mech", Date.now() + 1, "kin")).toHaveLength(2);
    expect(() =>
      saveProposedCards(db, { subjectId: "gone", cards: kept, provider: "p", model: "m" }),
    ).toThrow("subject-missing");
    expect(() => saveProposedCards(db, { cards: kept, provider: "p", model: "m" })).toThrow("subject-missing");
    db.close();
  });

  it("gives the cards of an exam the exam's subject, even when a subject is sent too", () => {
    const db = fixture();
    saveProposedCards(db, {
      planId: "org",
      topicId: "alk",
      subjectId: "phys",
      cards: kept,
      provider: "p",
      model: "m",
    });
    expect(db.prepare("SELECT DISTINCT plan_id, topic_id, subject_id FROM cards").all()).toEqual([
      { plan_id: "org", topic_id: "alk", subject_id: "chem" },
    ]);
    db.close();
  });
});

describe("where the cards go", () => {
  it("lists plans that have topics, newest first, without archived topics", () => {
    const db = fixture();
    const places = cardPlaces(db, {});
    expect(places.plans.map((plan) => plan.id)).toEqual(["org", "mech", "opt"]);
    expect(places.plans[1]!.topics.map((topic) => topic.id)).toEqual([
      "kin",
      "dyn",
    ]);
    expect(places.planId).toBeNull();
    expect(places.topicId).toBeNull();
    db.close();
  });

  it("keeps the lesson's plan and topic", () => {
    const db = fixture();
    expect(
      cardPlaces(db, { planId: "mech", topicId: "dyn", passageIds: ["p1"] }),
    ).toMatchObject({ planId: "mech", topicId: "dyn" });
    db.close();
  });

  it("takes a chat's plan, then the topic its cited passages belong to", () => {
    const db = fixture();
    expect(
      cardPlaces(db, { planId: "mech", passageIds: ["p1", "p2", "p3"] }),
    ).toMatchObject({ planId: "mech", topicId: "kin" });
    expect(cardPlaces(db, { planId: "mech" })).toMatchObject({
      planId: "mech",
      topicId: null,
    });
    db.close();
  });

  it("files under the subject alone unless the passages point to an exam's topic", () => {
    const db = fixture();
    // A chat's subject picks no exam by itself: the exam is optional and nothing points to one.
    expect(cardPlaces(db, { subject: "physics" })).toMatchObject({
      subjectId: "phys",
      planId: null,
      topicId: null,
    });
    expect(
      cardPlaces(db, { subject: "Physics", passageIds: ["p3"] }),
    ).toMatchObject({ subjectId: "phys", planId: "mech", topicId: "dyn" });
    // Passages alone pick the exam and topic, and the subject is the exam's.
    expect(cardPlaces(db, { passageIds: ["p3"] })).toMatchObject({
      subjectId: "phys",
      planId: "mech",
      topicId: "dyn",
    });
    expect(
      cardPlaces(db, { subject: "Unknown", passageIds: [] }),
    ).toMatchObject({ subjectId: null, planId: null, topicId: null });
    db.close();
  });

  it("takes the subject of the cited passages' sources when no exam's topic holds them", () => {
    const db = fixture();
    db.prepare("UPDATE sources SET subject_id = 'chem' WHERE id = 'src'").run();
    db.prepare("DELETE FROM topic_passages").run();
    expect(cardPlaces(db, { passageIds: ["p1", "p3"] })).toMatchObject({
      subjectId: "chem",
      planId: null,
      topicId: null,
    });
    // In the student's order, then by name.
    db.prepare("UPDATE subjects SET position = 1 WHERE id = 'chem'").run();
    expect(cardPlaces(db, {}).subjects).toEqual([
      { id: "phys", name: "Physics" },
      { id: "chem", name: "Chemistry" },
    ]);
    db.close();
  });

  it("keeps a map's cards in its own subject, offering only its exams, even when its passages point elsewhere", () => {
    const db = fixture();
    db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('bio', 'Biology', 1)").run();
    // p3 belongs to a Physics topic; a Chemistry map that cites it still files its cards under Chemistry, and with no
    // passage in a Chemistry topic no exam is preselected.
    expect(cardPlaces(db, { subjectId: "chem", passageIds: ["p3"] })).toMatchObject({
      plans: [expect.objectContaining({ id: "org", subjectId: "chem" })],
      subjectId: "chem",
      planId: null,
      topicId: null,
    });
    // A map of a topic keeps its exam and topic.
    expect(cardPlaces(db, { subjectId: "chem", planId: "org", topicId: "alk" })).toMatchObject({
      subjectId: "chem",
      planId: "org",
      topicId: "alk",
    });
    // A subject with no exam offers none: the cards go under the subject.
    expect(cardPlaces(db, { subjectId: "bio", passageIds: ["p3"] })).toMatchObject({
      plans: [],
      subjectId: "bio",
      planId: null,
      topicId: null,
    });
    // The id wins over a subject name that another subject has taken since.
    expect(cardPlaces(db, { subjectId: "bio", subject: "Physics", passageIds: ["p3"] })).toMatchObject({
      plans: [],
      subjectId: "bio",
      planId: null,
    });
    db.close();
  });
});
