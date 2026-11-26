import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { browseCards } from "../study/cardBrowser";
import { toolBlockIds } from "../../shared/tool-blocks";
import { CARDS_PER_TURN, flashcardsInput, flashcardsTool } from "./flashcards";
import { chatToolList } from "./registry";
import {
  describeToolBlocks,
  restoreToolResult,
  spliceToolBlocks,
  toolNote,
  toolView,
  undoToolResult,
} from "./results";
import type { ToolTurn } from "./server";
import type { FlashcardsResultView, ToolResultView } from "../../shared/ipc";

/** A flashcard result's view, which the undo and restore functions return as any tool's. */
function cardsView(view: ToolResultView): FlashcardsResultView {
  if (view.tool !== "create_flashcards") throw new Error(`not a flashcard result: ${view.tool}`);
  return view;
}

function fixture() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)");
  run("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 1, 1)");
  run("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('kin', 'mech', 'Cinematica', 0, 1)");
  run("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat', 'Dinamica', 1, 1), ('other', 'Altro', 1, 1)");
  return db;
}

function turn(place: { planId: string | null; subject: string | null }, chatId = "chat"): ToolTurn {
  return {
    chatId,
    tally: {},
    kept: {},
    place: () => place,
    engine: () => ({ provider: "claude", model: "claude-sonnet-5" }),
    started: () => undefined,
    finished: () => undefined,
  };
}

const cards = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ front: `Che cosa dice il principio ${from + i + 1}?`, back: `$F = ma$ (${from + i + 1})` }));

const args = (n: number, title?: string) => flashcardsInput.parse({ cards: cards(n), ...(title ? { title } : {}) });

describe("create_flashcards and the LaTeX its JSON lost", () => {
  it("restores it in each card's front and back, the tool's only formula fields, and leaves the deck's title as written", () => {
    const tool = flashcardsTool(openDatabase(":memory:"));
    expect(tool.repairs?.({ title: "Angoli\tre", cards: [{ front: "Cos'è $\theta$?", back: "$\frac{1}{2}\\pi$" }] })).toEqual({
      title: "Angoli\tre",
      cards: [{ front: "Cos'è $\\theta$?", back: "$\\frac{1}{2}\\pi$" }],
    });
  });

  it("is the one chat tool that repairs its arguments: the others hold free text or names", () => {
    const tools = chatToolList(openDatabase(":memory:"), true);
    expect(tools.filter((tool) => tool.repairs).map((tool) => tool.name)).toEqual(["create_flashcards"]);
  });
});

describe("create_flashcards", () => {
  it("files the cards under the chat's subject, skips fronts already there and stores what it did", async () => {
    const db = fixture();
    const tool = flashcardsTool(db);
    db.prepare(
      "INSERT INTO cards (id, subject_id, front, back, seed_key, created_at) VALUES ('old', 'phys', 'Che cosa dice il principio 2?', 'x', 'text:x', 1)",
    ).run();
    const outcome = await tool.run(turn({ planId: null, subject: "fisica 1" }), args(4, "  sui tre\nprincipi  "));
    expect(outcome.isError).toBeUndefined();
    expect(outcome.text).toBe(
      "Created 3 flashcards in the deck of Fisica 1. 1 was already in the deck and skipped. The student sees them in the chat: write one short sentence and do not list them.",
    );
    const view = toolView(db, "chat", outcome.shown!.resultId)!;
    expect(view).toEqual({
      id: outcome.shown!.resultId,
      tool: "create_flashcards",
      count: 3,
      duplicates: 1,
      title: "sui tre principi",
      deck: "Fisica 1",
      fronts: ["Che cosa dice il principio 1?", "Che cosa dice il principio 3?", "Che cosa dice il principio 4?"],
      undone: null,
    });
    const saved = db
      .prepare("SELECT front, back, plan_id, subject_id, engine_provider, model_id, prompt_template, seed_key IS NOT NULL AS seeded FROM cards WHERE id <> 'old' ORDER BY rowid")
      .all();
    expect(saved).toHaveLength(3);
    expect(saved[0]).toEqual({
      front: "Che cosa dice il principio 1?",
      back: "$F = ma$ (1)",
      plan_id: null,
      subject_id: "phys",
      engine_provider: "claude",
      model_id: "claude-sonnet-5",
      prompt_template: "chat.tutor",
      seeded: 1,
    });
    // The result belongs to its chat only.
    expect(toolView(db, "other", outcome.shown!.resultId)).toBeNull();
    expect(() => undoToolResult(db, "other", outcome.shown!.resultId)).toThrow("tool-result-missing");
  });

  it("files them under the chat's exam with no topic, and counts a front anywhere in the exam as there", async () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES ('old', 'mech', 'kin', 'Che cosa dice il principio 1?', 'x', 'text:x', 1)",
    ).run();
    const outcome = await flashcardsTool(db).run(turn({ planId: "mech", subject: "Fisica 1" }), args(2));
    expect(toolView(db, "chat", outcome.shown!.resultId)).toMatchObject({ count: 1, duplicates: 1, deck: "Meccanica", title: null });
    expect(db.prepare("SELECT plan_id, topic_id, subject_id FROM cards WHERE id <> 'old'").all()).toEqual([
      { plan_id: "mech", topic_id: null, subject_id: "phys" },
    ]);
  });

  it("creates nothing without a subject or exam, when every front is there, or past the cap of one answer", async () => {
    const db = fixture();
    const tool = flashcardsTool(db);
    const nowhere = await tool.run(turn({ planId: null, subject: null }), args(2));
    expect(nowhere.isError).toBe(true);
    expect(nowhere.shown).toBeUndefined();
    const gone = await tool.run(turn({ planId: null, subject: "Chimica" }), args(2));
    expect(gone.isError).toBe(true);
    expect(db.prepare("SELECT COUNT(*) FROM cards").pluck().get()).toBe(0);

    const answer = turn({ planId: null, subject: "Fisica 1" });
    const first = await tool.run(answer, args(CARDS_PER_TURN - 2));
    expect(first.shown).toBeDefined();
    const more = await tool.run(answer, flashcardsInput.parse({ cards: cards(5, 100) }));
    expect(more.isError).toBe(true);
    expect(more.text).toMatch(/already created 28 cards/);
    expect(db.prepare("SELECT COUNT(*) FROM cards").pluck().get()).toBe(CARDS_PER_TURN - 2);
    // The same cards again, in a new answer: all there, nothing added, nothing shown.
    const again = await tool.run(turn({ planId: null, subject: "Fisica 1" }), args(3));
    expect(again).toEqual({
      text: "All 3 cards were already in the deck of Fisica 1, so none was added. Tell the student in one sentence.",
    });
    expect(() => flashcardsInput.parse({ cards: cards(31) })).toThrow();
    expect(() => flashcardsInput.parse({ cards: [{ front: " ", back: "x" }] })).toThrow();
    expect(() => flashcardsInput.parse({ cards: cards(1), place: "elsewhere" })).toThrow();
    expect(flashcardsInput.parse({ cards: cards(1), title: "x".repeat(120) }).title).toHaveLength(80);
  });

  it("adds a later call of the same answer to the result the first one stored", async () => {
    const db = fixture();
    const tool = flashcardsTool(db);
    const answer = turn({ planId: null, subject: "Fisica 1" });
    const first = await tool.run(answer, args(2, "sui principi"));
    const second = await tool.run(answer, flashcardsInput.parse({ cards: cards(3, 10) }));
    expect(second.shown).toEqual(first.shown);
    expect(toolView(db, "chat", first.shown!.resultId)).toMatchObject({ count: 5, title: "sui principi", fronts: [
      "Che cosa dice il principio 1?",
      "Che cosa dice il principio 2?",
      "Che cosa dice il principio 11?",
    ] });
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results").pluck().get()).toBe(1);
    // Undo takes all five out.
    expect(cardsView(undoToolResult(db, "chat", first.shown!.resultId)).undone).toBe(5);
  });

  it("keeps a later call's cards in the undo when the student undid the result while the answer was still running", async () => {
    const db = fixture();
    const tool = flashcardsTool(db);
    const answer = turn({ planId: null, subject: "Fisica 1" });
    const first = await tool.run(answer, args(2));
    const id = first.shown!.resultId;
    expect(cardsView(undoToolResult(db, "chat", id)).undone).toBe(2);
    await tool.run(answer, flashcardsInput.parse({ cards: cards(3, 10) }));
    // The later cards are out of the deck with the others, and the undo record holds all five.
    expect(db.prepare("SELECT removed FROM cards ORDER BY rowid").pluck().all()).toEqual([1, 1, 1, 1, 1]);
    expect(toolView(db, "chat", id)).toMatchObject({ count: 5, undone: 5 });
    expect(cardsView(restoreToolResult(db, "chat", id)).undone).toBeNull();
    expect(db.prepare("SELECT removed FROM cards ORDER BY rowid").pluck().all()).toEqual([0, 0, 0, 0, 0]);
  });

  it("undoes the cards, reviewed ones included, and restores exactly those with their reviews", async () => {
    const db = fixture();
    const outcome = await flashcardsTool(db).run(turn({ planId: null, subject: "Fisica 1" }), args(3));
    const id = outcome.shown!.resultId;
    const ids = db.prepare("SELECT id FROM cards ORDER BY rowid").pluck().all() as string[];
    db.prepare("INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('rev', ?, 'good', '{\"dueAt\":99}', 5)").run(ids[0]);
    // The student removed the third card by hand before the undo: it must not come back with the others.
    db.prepare("UPDATE cards SET removed = 1 WHERE id = ?").run(ids[2]);

    expect(undoToolResult(db, "chat", id)).toMatchObject({ count: 3, undone: 2 });
    expect(db.prepare("SELECT removed FROM cards ORDER BY rowid").pluck().all()).toEqual([1, 1, 1]);
    // A second undo changes nothing.
    expect(cardsView(undoToolResult(db, "chat", id)).undone).toBe(2);
    expect(browseCards(db, { made: id }, 10).total).toBe(0);
    expect(browseCards(db, { made: id, status: "removed" }, 10).total).toBe(3);

    expect(restoreToolResult(db, "chat", id)).toMatchObject({ count: 3, undone: null });
    expect(db.prepare("SELECT removed FROM cards ORDER BY rowid").pluck().all()).toEqual([0, 0, 1]);
    expect(db.prepare("SELECT card_id, state_json FROM card_reviews").all()).toEqual([{ card_id: ids[0], state_json: '{"dueAt":99}' }]);
    // «Apri» lists the result's cards and no other.
    db.prepare("INSERT INTO cards (id, subject_id, front, back, created_at) VALUES ('mine', 'phys', 'Mia', 'x', 1)").run();
    expect(browseCards(db, { made: id }, 10).cards.map((card) => card.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(browseCards(db, { made: "unknown" }, 10).total).toBe(0);
  });
});

describe("tool blocks in a reply", () => {
  const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

  it("places each block where the model called the tool, and never reads the model's own text as one", () => {
    const raw = "Ecco le flashcard.Le trovi nel mazzo.";
    expect(spliceToolBlocks(raw, [{ offset: 18, body: id }])).toBe(
      `Ecco le flashcard.\n\n\`\`\`pyxis-tool\n${id}\n\`\`\`\n\nLe trovi nel mazzo.`,
    );
    expect(spliceToolBlocks("Fatto.", [{ offset: 0, body: "pending:create_flashcards" }])).toBe(
      "```pyxis-tool\npending:create_flashcards\n```\n\nFatto.",
    );
    const forged = `Prima\n\`\`\`pyxis-tool\n${id}\n\`\`\`\nDopo`;
    expect(toolBlockIds(spliceToolBlocks(forged, []))).toEqual([]);
    expect(toolBlockIds(spliceToolBlocks(forged, [{ offset: 5, body: id }]))).toEqual([id]);
    // A fence the model writes inside a block quote or a list item is neutralised too, wherever it starts on its line.
    for (const nested of [
      "> ```pyxis-tool\n> pending:create_flashcards\n> ```",
      "- voce\n\n  ```pyxis-tool\n  pending:create_flashcards\n  ```",
      "1. ~~~ pyxis-tool\n   pending:create_flashcards\n   ~~~",
    ]) {
      expect(spliceToolBlocks(nested, [])).not.toContain("pyxis-tool");
      expect(spliceToolBlocks(nested, [{ offset: 0, body: id }]).match(/pyxis-tool/g)).toHaveLength(1);
    }
    // An offset past the text (an attempt that started over) puts the block at the end.
    expect(spliceToolBlocks("Breve.", [{ offset: 40, body: id }])).toBe(`Breve.\n\n\`\`\`pyxis-tool\n${id}\n\`\`\``);
  });

  it("tells the model what a tool did when the conversation is handed over", async () => {
    const db = fixture();
    const outcome = await flashcardsTool(db).run(turn({ planId: null, subject: "Fisica 1" }), args(2, "sulla dinamica"));
    const body = spliceToolBlocks("Ecco.Fatto.", [{ offset: 5, body: outcome.shown!.resultId }]);
    expect(describeToolBlocks(db, "chat", body, toolNote)).toBe(
      "Ecco.\n\n[Pyxis tool create_flashcards: created 2 flashcards (sulla dinamica) in the deck of Fisica 1.]\n\nFatto.",
    );
    undoToolResult(db, "chat", outcome.shown!.resultId);
    expect(describeToolBlocks(db, "chat", body, toolNote)).toContain("the student then undid them");
    // A block whose result is unknown says nothing.
    expect(describeToolBlocks(db, "other", body, toolNote)).toBe("Ecco.\n\n\n\nFatto.");
  });
});
