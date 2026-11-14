import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { planGuide } from "../plans/create";
import { onEvidenceChanged } from "../plans/evidenceCache";
import { planMastery } from "../plans/progress";
import { readSteps } from "../plans/steps";
import { parseSmartText, smartQuestions } from "../../shared/smart-text";
import { studyHandlers } from "./handlers";
import { mistakesNotebook } from "./notebook";
import { markPartDone, nextPart } from "./partProgress";
import { partOfText } from "./partText";
import { answerSmartCheck } from "./smartText";
import { checkBlock, partMarkdown, recapMarkdown, seedOutline, writeSeedPart } from "./test-parts";

type Db = ReturnType<typeof openDatabase>;

/** Saturday 17 October 2026, 10:00 local time, as the planner's tests. */
const now = new Date(2026, 9, 17, 10).getTime();
const at = (dayOffset: number, hour = 9) => new Date(2026, 9, 17 + dayOffset, hour).getTime();

/** A lesson that is not a part: two quick checks and a closing recap of two questions. */
const wholeLesson = [
  "## Velocità",
  "",
  checkBlock("Che cos'è la velocità?"),
  "",
  "```pyxis-recap",
  JSON.stringify({
    questions: [
      { question: "Ripasso 1", options: ["a", "b"], answer: 0 },
      { question: "Ripasso 2", options: ["a", "b"], answer: 1 },
    ],
  }),
  "```",
].join("\n");

/**
 * A plan with three topics in order: t1 (its lesson in parts when `outline` is set), t2 (a lesson that is not a part,
 * item `whole`) and t3 (nothing yet).
 */
function workspace(outline: boolean) {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans (id, title, status, target, exam_at, created_at, updated_at) VALUES ('p', 'Analisi 2', 'ready', 0.75, ?, 1, 1)",
  ).run(at(30));
  for (const [index, id] of ["t1", "t2", "t3"].entries())
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'p', ?, ?, 1)").run(id, `Topic ${id}`, index);
  db.prepare(
    "INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, created_at) VALUES ('whole', 'p', 't2', 'lesson', ?, 'claude', 1)",
  ).run(JSON.stringify({ cacheKey: "whole", markdown: wholeLesson, passageIds: [] }));
  const seeded = outline
    ? seedOutline(db, {
        planId: "p",
        topicId: "t1",
        parts: [
          { title: "Intorni", minutes: 6, markdown: partMarkdown("Intorni") },
          { title: "Aperti e chiusi", minutes: 5, markdown: partMarkdown("Aperti") },
          { title: "Compatti", minutes: 7 },
          { kind: "recap", title: "Ripasso del capitolo", minutes: 4, markdown: recapMarkdown("Ripasso") },
        ],
      })
    : null;
  return { db, seeded };
}

const questionsOf = (db: Db, itemId: string) => {
  const { body_json } = db.prepare("SELECT body_json FROM items WHERE id = ?").get(itemId) as { body_json: string };
  return [...smartQuestions(parseSmartText((JSON.parse(body_json) as { markdown: string }).markdown)).values()];
};

/** Answers the questions of an item, right or wrong, and returns the last answer's result. */
function answer(db: Db, itemId: string, options: { right?: boolean; at?: number; from?: number; to?: number } = {}) {
  let last: ReturnType<typeof answerSmartCheck> | undefined;
  for (const question of questionsOf(db, itemId).slice(options.from ?? 0, options.to))
    last = answerSmartCheck(
      db,
      {
        planId: "p",
        itemId,
        blockId: question.id,
        pick: options.right === false ? (question.answer + 1) % question.options.length : question.answer,
      },
      options.at ?? now,
    );
  return last!;
}

const doneAt = (db: Db, partId: string) =>
  (db.prepare("SELECT done_at AS doneAt FROM lesson_parts WHERE id = ?").get(partId) as { doneAt: number | null }).doneAt;
const lessonSteps = (db: Db, topicId: string) =>
  readSteps(db, "p").filter((step) => step.activity === "lesson" && step.topicId === topicId);
const answers = (db: Db) =>
  (db.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'answer_given'").get() as { n: number }).n;

describe("a part is done", () => {
  it("once its question is answered, right or wrong, and says so in the answer", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2] = seeded!.parts;
    expect(answer(db, p1!.itemId!, { right: true })).toEqual({ correct: true, pick: expect.any(Number), finished: false, partDone: true });
    expect(doneAt(db, p1!.id)).toBe(now);
    expect(answer(db, p2!.itemId!, { right: false, at: now + 1 })).toMatchObject({ correct: false, finished: false, partDone: true });
    expect(doneAt(db, p2!.id)).toBe(now + 1);
    // Reading a part records no lesson step; the last part missing does.
    expect(lessonSteps(db, "t1")).toEqual([]);
    db.close();
  });

  it("stays done: answering again returns the saved pick and changes nothing", () => {
    const { db, seeded } = workspace(true);
    const p1 = seeded!.parts[0]!;
    const first = answer(db, p1.itemId!, { right: false });
    const events = answers(db);
    expect(answer(db, p1.itemId!, { right: true, at: now + 60_000 })).toEqual(first);
    expect(answers(db)).toBe(events);
    expect(doneAt(db, p1.id)).toBe(now);
    db.close();
  });

  it("only with its last question: an earlier check in the same part leaves it open", () => {
    const { db, seeded } = workspace(true);
    const part = seeded!.parts[2]!;
    const itemId = writeSeedPart(db, {
      planId: "p",
      topicId: "t1",
      partId: part.id,
      markdown: [checkBlock("Prima?"), "", "## Compatti", "", checkBlock("Ultima?")].join("\n"),
    });
    expect(answer(db, itemId, { to: 1 })).toMatchObject({ partDone: false, finished: false });
    expect(doneAt(db, part.id)).toBeNull();
    expect(answer(db, itemId, { from: 1 })).toMatchObject({ partDone: true });
    db.close();
  });

  it("finishes the topic's lesson with the recap's three answers once every part before it is done, once, with part 1's item on the step", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2, p3, recap] = seeded!.parts;
    answer(db, p1!.itemId!, { at: now - 3 });
    answer(db, p2!.itemId!, { at: now - 2 });
    markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now - 1);
    expect(answer(db, recap!.itemId!, { to: 2 })).toMatchObject({ partDone: false, finished: false });
    expect(lessonSteps(db, "t1")).toEqual([]);
    expect(answer(db, recap!.itemId!, { from: 2, at: now + 5 })).toMatchObject({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toEqual([expect.objectContaining({ itemId: seeded!.parts[0]!.itemId, at: now + 5 })]);
    expect(doneAt(db, p3!.id)).toBe(now - 1);
    // Answering the recap again keeps one step, as a lesson's recap did.
    expect(answer(db, recap!.itemId!, { at: now + 9 })).toMatchObject({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toHaveLength(1);
    db.close();
  });

  it("finishes the lesson with whichever part is the last one missing, in any order, and never again", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2, , recap] = seeded!.parts;
    answer(db, p2!.itemId!);
    expect(lessonSteps(db, "t1")).toEqual([]);
    // The recap first of the rest does not read the lesson: part 1 and part 3 are still open.
    expect(answer(db, recap!.itemId!, { at: now + 1 })).toMatchObject({ partDone: true, finished: false });
    expect(lessonSteps(db, "t1")).toEqual([]);
    expect(answer(db, p1!.itemId!, { at: now + 2 })).toMatchObject({ partDone: true, finished: false });
    expect(lessonSteps(db, "t1")).toEqual([]);
    // Part 3 is the last one missing, though it is neither the first nor the last in position.
    expect(markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now + 3)).toEqual({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toEqual([expect.objectContaining({ itemId: p1!.itemId, at: now + 3 })]);
    // Each part again, by its question or by Fatto: the same answer, and still one step.
    expect(answer(db, p1!.itemId!, { at: now + 4 })).toMatchObject({ partDone: true, finished: true });
    expect(markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now + 5)).toEqual({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toHaveLength(1);
    db.close();
  });

  it("leaves the lesson unread when the recap is read first and while any part is open, also on the last day", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2, , recap] = seeded!.parts;
    answer(db, recap!.itemId!);
    answer(db, p1!.itemId!, { at: now + 1 });
    answer(db, p2!.itemId!, { at: now + 2 });
    // Part 3 is not written and not done: the lesson is not read, and the part is the one the page names next.
    expect(lessonSteps(db, "t1")).toEqual([]);
    expect(nextPart(db, "t1", now + 3)).toMatchObject({ position: 3, written: false });
    // Read a day later, the last missing part records the step at that time.
    expect(markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, at(1, 9))).toEqual({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toEqual([expect.objectContaining({ at: at(1, 9) })]);
    expect(nextPart(db, "t1", at(1, 9))).toBeNull();
    db.close();
  });

  it("does not count a part whose write failed as done, so it keeps the lesson unread", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2, p3, recap] = seeded!.parts;
    db.prepare("UPDATE lesson_parts SET write_failed_at = ? WHERE id = ?").run(now, p3!.id);
    for (const part of [p1!, p2!, recap!]) expect(answer(db, part.itemId!, { at: now + 1 })).toMatchObject({ partDone: true, finished: false });
    expect(doneAt(db, p3!.id)).toBeNull();
    expect(lessonSteps(db, "t1")).toEqual([]);
    db.close();
  });

  it("records no second lesson step after a later rewrite of a part or of the whole lesson", () => {
    const { db, seeded } = workspace(true);
    const recap = seeded!.parts[3]!;
    for (const part of seeded!.parts.slice(0, 3).filter((entry) => entry.itemId)) answer(db, part.itemId!, { at: now - 1 });
    markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now - 1);
    answer(db, recap.itemId!);
    expect(lessonSteps(db, "t1")).toHaveLength(1);
    // "Riscrivi questa parte": new text with a new question in the same item. The part stays done at its first time.
    db.prepare("UPDATE items SET body_json = ? WHERE id = ?").run(
      JSON.stringify({ cacheKey: "again", markdown: recapMarkdown("Di nuovo"), passageIds: [] }),
      recap.itemId,
    );
    expect(answer(db, recap.itemId!, { at: now + 1 })).toMatchObject({ partDone: true, finished: true });
    expect(doneAt(db, recap.id)).toBe(now);
    // A new outline in place of the first one: its last part done adds no step either.
    db.prepare("UPDATE lesson_outlines SET retired_at = ? WHERE topic_id = 't1'").run(now + 2);
    const again = seedOutline(db, { planId: "p", topicId: "t1", id: "again", parts: [{ markdown: partMarkdown("Uno") }, { markdown: partMarkdown("Due") }] });
    expect(answer(db, again.parts[1]!.itemId!, { at: now + 3 })).toMatchObject({ partDone: true, finished: false });
    expect(answer(db, again.parts[0]!.itemId!, { at: now + 4 })).toMatchObject({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toHaveLength(1);
    db.close();
  });

  it("from an earlier wording of its text as from the current one", () => {
    const { db, seeded } = workspace(true);
    const [, p2, , recap] = seeded!.parts;
    // Part 2 and the recap written again in simple wording: each part now points at its new item.
    writeSeedPart(db, { planId: "p", topicId: "t1", partId: p2!.id, markdown: partMarkdown("Aperti, semplice"), wording: "simple" });
    writeSeedPart(db, { planId: "p", topicId: "t1", partId: recap!.id, markdown: recapMarkdown("Ripasso semplice"), wording: "simple" });
    expect(answer(db, p2!.itemId!)).toMatchObject({ partDone: true, finished: false });
    expect(doneAt(db, p2!.id)).toBe(now);
    answer(db, seeded!.parts[0]!.itemId!, { at: now });
    markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now);
    expect(answer(db, recap!.itemId!, { at: now + 1 })).toMatchObject({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toEqual([expect.objectContaining({ itemId: seeded!.parts[0]!.itemId })]);
    db.close();
  });

  it("keeps a part done on an archived topic, with no step to add", () => {
    const { db, seeded } = workspace(true);
    db.prepare("UPDATE topics SET archived_at = 1 WHERE id = 't1'").run();
    expect(answer(db, seeded!.parts[3]!.itemId!)).toMatchObject({ partDone: true, finished: false });
    for (const part of seeded!.parts.slice(0, 2)) answer(db, part.itemId!);
    expect(markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now)).toEqual({ partDone: true, finished: true });
    expect(doneAt(db, seeded!.parts[3]!.id)).toBe(now);
    expect(readSteps(db, "p")).toEqual([]);
    db.close();
  });

  it("answers a lesson that is not a part as before, whether another topic has parts or not", () => {
    const results = [false, true].map((outline) => {
      const { db } = workspace(outline);
      const right = answer(db, "whole", { to: 1 });
      const wrong = answer(db, "whole", { right: false, from: 1 });
      // A lesson that is not a part records its step at the clock's time, not the answer's, so only the item is compared.
      const steps = lessonSteps(db, "t2").map(({ itemId }) => ({ itemId }));
      db.close();
      return { right, wrong, steps };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[0]!.right).toEqual({ correct: true, pick: expect.any(Number), finished: false });
    expect(Object.keys(results[0]!.wrong)).toEqual(["correct", "pick", "finished"]);
    expect(results[0]!.steps).toEqual([{ itemId: "whole" }]);
  });
});

describe("a part's texts", () => {
  it("are the text a part points at and its earlier wordings, in a live or a retired outline, and nothing else", () => {
    const { db, seeded } = workspace(true);
    const p2 = seeded!.parts[1]!;
    const part = { partId: p2.id, outlineId: seeded!.outlineId, position: 2, kind: "part" };
    const simple = writeSeedPart(db, { planId: "p", topicId: "t1", partId: p2.id, markdown: partMarkdown("Semplice"), wording: "simple" });
    expect(partOfText(db, simple)).toEqual(part);
    expect(partOfText(db, p2.itemId!)).toEqual(part);
    db.prepare("UPDATE lesson_outlines SET retired_at = 2 WHERE id = ?").run(seeded!.outlineId);
    expect(partOfText(db, p2.itemId!)).toEqual(part);
    // A lesson that is not a part, a part template whose scope names no part, and an unknown item.
    expect(partOfText(db, "whole")).toBeNull();
    db.prepare(
      "INSERT INTO items (id, plan_id, topic_id, kind, body_json, prompt_template, created_at) VALUES ('stray', 'p', 't1', 'lesson', ?, 'lesson.part', 1)",
    ).run(JSON.stringify({ cacheKey: JSON.stringify({ scopeId: "t1" }), markdown: "" }));
    expect(partOfText(db, "stray")).toBeNull();
    expect(partOfText(db, "missing")).toBeNull();
    db.close();
  });
});

describe("telling the exam page", () => {
  it("reports a part done by its question or by Fatto, and nothing when the part was already done", () => {
    const { db, seeded } = workspace(true);
    let changes = 0;
    onEvidenceChanged(db, () => (changes += 1));
    const after = (write: () => unknown) => {
      changes = 0;
      write();
      return changes;
    };
    expect(after(() => answer(db, seeded!.parts[0]!.itemId!))).toBeGreaterThan(0);
    // "Fatto" on a part that is not the last writes no event: only the part's done time changes.
    expect(after(() => markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now))).toBeGreaterThan(0);
    expect(after(() => answer(db, seeded!.parts[0]!.itemId!, { at: now + 1 }))).toBe(0);
    expect(after(() => markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, now + 1))).toBe(0);
    db.close();
  });
});

describe("Fatto on a part", () => {
  it("finishes a part with no question: not written yet, or written without a check", () => {
    const { db, seeded } = workspace(true);
    const handlers = studyHandlers(db);
    expect(handlers.partDone({ planId: "p", topicId: "t1", position: 3 })).toEqual({ partDone: true, finished: false });
    expect(doneAt(db, seeded!.parts[2]!.id)).not.toBeNull();
    writeSeedPart(db, { planId: "p", topicId: "t1", partId: seeded!.parts[3]!.id, markdown: "## Ripasso\n\nNessuna domanda.", wording: "simple" });
    // The recap done on its own does not finish the lesson: parts 1 and 2 are open.
    expect(markPartDone(db, { planId: "p", topicId: "t1", position: 4 }, now)).toEqual({ partDone: true, finished: false });
    expect(lessonSteps(db, "t1")).toEqual([]);
    answer(db, seeded!.parts[0]!.itemId!);
    expect(answer(db, seeded!.parts[1]!.itemId!, { at: now })).toMatchObject({ partDone: true, finished: true });
    expect(lessonSteps(db, "t1")).toEqual([expect.objectContaining({ itemId: seeded!.parts[0]!.itemId, at: now })]);
    db.close();
  });

  it("is refused on a part with a question, a part or outline that does not exist, and a topic of another plan", () => {
    const { db } = workspace(true);
    const done = (topicId: string, position: number, planId = "p") => () => markPartDone(db, { planId, topicId, position }, now);
    expect(done("t1", 1)).toThrow("part-has-question");
    expect(done("t1", 4)).toThrow("part-has-question");
    expect(done("t1", 5)).toThrow("part-missing");
    expect(done("t2", 1)).toThrow("part-missing");
    expect(done("t1", 3, "other")).toThrow("topic-missing");
    expect(readSteps(db, "p")).toEqual([]);
    db.close();
  });

  it("names the first written part on the step, or no part when none is written", () => {
    const { db } = workspace(false);
    const bare = seedOutline(db, { planId: "p", topicId: "t3", parts: [{}, {}] });
    markPartDone(db, { planId: "p", topicId: "t3", position: 1 }, now);
    expect(markPartDone(db, { planId: "p", topicId: "t3", position: 2 }, now)).toEqual({ partDone: true, finished: true });
    // With no item to name, the step falls back to the topic's newest lesson item, as `plans.complete` does: none here.
    expect(lessonSteps(db, "t3")).toEqual([expect.objectContaining({ itemId: null })]);
    expect(bare.parts.every((part) => doneAt(db, part.id) === now)).toBe(true);
    db.close();
  });
});

describe("mastery of a lesson in parts", () => {
  const mastery = (db: Db, topicId: string, when = now + 60_000) =>
    planMastery(db, "p", when).find((topic) => topic.id === topicId)!.mastery;

  it("counts the check of every part answered, and the recap's answers", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2, , recap] = seeded!.parts;
    answer(db, p1!.itemId!);
    answer(db, p2!.itemId!, { at: now + 1 });
    // Two right answers of weight 0.5: 1 / 4. Before parts only the lesson answered last counted, which was part 2.
    expect(mastery(db, "t1")).toBeCloseTo(1 / 4);
    answer(db, recap!.itemId!, { at: now + 2 });
    expect(mastery(db, "t1")).toBeCloseTo(2.5 / 5.5);
    db.close();
  });

  it("is the same in whatever order the parts are read, with no lesson step behind it", () => {
    const values = [[3, 1, 0], [0, 1, 3]].map((order) => {
      const { db, seeded } = workspace(true);
      order.forEach((index, turn) => answer(db, seeded!.parts[index]!.itemId!, { at: now + turn }));
      const value = { mastery: mastery(db, "t1"), steps: lessonSteps(db, "t1").length };
      db.close();
      return value;
    });
    // The answers' times differ by a few milliseconds, so the decay does too.
    expect(values[1]!.mastery).toBeCloseTo(values[0]!.mastery, 6);
    expect(values[1]!.steps).toBe(values[0]!.steps);
    // Part 3 is not read, so neither order has finished the lesson.
    expect(values[0]!.steps).toBe(0);
    expect(values[0]!.mastery).toBeCloseTo(2.5 / 5.5);
  });

  it("counts a part read at two levels once, from the text answered last, and keeps the other parts meanwhile", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2] = seeded!.parts;
    answer(db, p1!.itemId!);
    answer(db, p2!.itemId!, { right: false, at: now + 1 });
    // One right and one wrong answer of weight 0.5: 0.5 / 4.
    expect(mastery(db, "t1")).toBeCloseTo(0.5 / 4);
    // Part 2 written again in simple wording: the part points at the new item, and the old item and its wrong answer
    // still count for part 2 until the new text is answered.
    const simple = writeSeedPart(db, { planId: "p", topicId: "t1", partId: p2!.id, markdown: partMarkdown("Aperti, semplice"), wording: "simple" });
    expect(mastery(db, "t1")).toBeCloseTo(0.5 / 4);
    answer(db, simple, { at: now + 2 });
    expect(mastery(db, "t1")).toBeCloseTo(1 / 4);
    db.close();
  });

  it("follows the lesson answered last: the outline that replaced an old lesson, or an old lesson answered after it", () => {
    const { db, seeded } = workspace(true);
    const oldLesson = (id: string) =>
      db
        .prepare(
          "INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, created_at) VALUES (?, 'p', 't1', 'lesson', ?, 'claude', 1)",
        )
        .run(id, JSON.stringify({ cacheKey: id, markdown: wholeLesson, passageIds: [] }));
    oldLesson("old");
    db.prepare("UPDATE lesson_outlines SET replaces_item_id = 'old' WHERE id = ?").run(seeded!.outlineId);
    // The old lesson answered before the outline was read, all right: three answers, 1.5 / 4.5.
    answer(db, "old", { at: now - 10 });
    expect(mastery(db, "t1")).toBeCloseTo(1.5 / 4.5);
    // The outline's first answer replaces it.
    answer(db, seeded!.parts[0]!.itemId!, { at: now });
    expect(mastery(db, "t1")).toBeCloseTo(0.5 / 3.5);
    // An old lesson in another wording answered after the outline replaces the parts, as another wording always did.
    oldLesson("old-simple");
    answer(db, "old-simple", { at: now + 10, to: 1 });
    expect(mastery(db, "t1")).toBeCloseTo(0.5 / 3.5);
    answer(db, "old-simple", { at: now + 11, from: 1, right: false });
    expect(mastery(db, "t1")).toBeCloseTo(0.5 / 4.5);
    db.close();
  });

  it("follows an item that becomes a part, also once mastery is cached", () => {
    const { db, seeded } = workspace(true);
    db.prepare(
      "INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, created_at) VALUES ('x', 'p', 't1', 'lesson', ?, 'claude', 1)",
    ).run(JSON.stringify({ cacheKey: "x", markdown: wholeLesson, passageIds: [] }));
    answer(db, "x", { at: now - 10 });
    answer(db, seeded!.parts[0]!.itemId!, { at: now });
    expect(mastery(db, "t1")).toBeCloseTo(0.5 / 3.5);
    // Only the part row changes: the item's three answers now count with part 1's.
    db.prepare("UPDATE lesson_parts SET item_id = 'x' WHERE id = ?").run(seeded!.parts[2]!.id);
    expect(mastery(db, "t1")).toBeCloseTo(2 / 5);
    db.close();
  });

  it("leaves a topic without parts as it was, whether another topic has parts or not", () => {
    const results = [false, true].map((outline) => {
      const { db, seeded } = workspace(outline);
      answer(db, "whole", { to: 2 });
      if (seeded) answer(db, seeded.parts[0]!.itemId!);
      const value = mastery(db, "t2");
      db.close();
      return value;
    });
    expect(results[1]).toBe(results[0]);
    expect(results[0]).toBeCloseTo(1 / 4);
  });
});

describe("Da rifare", () => {
  it("lists a part's wrong answer as a quick check to redo", () => {
    const { db, seeded } = workspace(true);
    answer(db, seeded!.parts[0]!.itemId!, { right: false });
    answer(db, seeded!.parts[1]!.itemId!, { right: true });
    const notebook = mistakesNotebook(db, { planId: "p" });
    const entries = JSON.stringify(notebook);
    expect(entries).toContain("Che cos'è Intorni?");
    expect(entries).not.toContain("Che cos'è Aperti?");
    db.close();
  });
});

describe("the suggestion names the part", () => {
  const next = (db: Db, when = now) => planGuide(db, "p", when)!.next;

  it("names the first part not done of a lesson in parts, and no part on any other suggestion", () => {
    const { db, seeded } = workspace(true);
    // Evidence on another topic counts as study, so the path suggests the next lesson rather than the start.
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('e', 'answer_given', 'p', 't3', '{"score":1,"evidenceKind":"quiz"}', ?)`,
    ).run(at(-3));
    expect(next(db)).toEqual({
      activity: "lesson",
      topicId: "t1",
      reason: "next",
      count: 0,
      part: { position: 1, count: 3, kind: "part", title: "Intorni", minutes: 6, written: true, resumeFrom: null },
    });
    answer(db, seeded!.parts[0]!.itemId!, { at: at(0, 8) });
    answer(db, seeded!.parts[1]!.itemId!, { at: at(0, 9) });
    expect(next(db)!.part).toEqual({ position: 3, count: 3, kind: "part", title: "Compatti", minutes: 7, written: false, resumeFrom: null });
    markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, at(0, 9));
    expect(next(db)!.part).toMatchObject({ position: 4, kind: "recap", title: "Ripasso del capitolo", minutes: 4, written: true });
    db.close();
  });

  it("says where to resume once the last part done was done before today", () => {
    const { db, seeded } = workspace(true);
    answer(db, seeded!.parts[1]!.itemId!, { at: at(-2, 20) });
    answer(db, seeded!.parts[0]!.itemId!, { at: at(-1, 23) });
    expect(next(db)!.part).toMatchObject({ position: 3, resumeFrom: { position: 1, at: at(-1, 23) } });
    // Just after midnight it is still yesterday's part; a part done today clears it.
    expect(next(db, at(0, 0) + 1)!.part!.resumeFrom).toEqual({ position: 1, at: at(-1, 23) });
    markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, at(0, 9));
    expect(next(db)!.part!.resumeFrom).toBeNull();
    db.close();
  });

  it("puts the topic with parts done before the first unread topic", () => {
    const { db } = workspace(false);
    const outline = seedOutline(db, { planId: "p", topicId: "t3", parts: [{ markdown: partMarkdown("Taylor") }, {}] });
    answer(db, outline.parts[0]!.itemId!, { at: at(-1) });
    expect(next(db)).toMatchObject({ activity: "lesson", topicId: "t3", part: { position: 2, written: false } });
    db.close();
  });

  it("keeps naming the unread parts, and stays on the topic, when the recap was read first", () => {
    const { db, seeded } = workspace(true);
    const [p1, p2, , recap] = seeded!.parts;
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('e', 'answer_given', 'p', 't3', '{"score":1,"evidenceKind":"quiz"}', ?)`,
    ).run(at(-3));
    answer(db, recap!.itemId!, { at: at(0, 8) });
    // The lesson is not read: the card names part 1, and the path prefers this topic over the unread ones.
    expect(lessonSteps(db, "t1")).toEqual([]);
    expect(next(db)).toMatchObject({ activity: "lesson", topicId: "t1", part: { position: 1, count: 3, written: true } });
    expect(planGuide(db, "p", now)!.topics.find((topic) => topic.topicId === "t1")!.read).toBe(false);
    answer(db, p1!.itemId!, { at: at(0, 9) });
    answer(db, p2!.itemId!, { at: at(0, 9) });
    expect(next(db)!.part).toMatchObject({ position: 3, written: false });
    markPartDone(db, { planId: "p", topicId: "t1", position: 3 }, at(0, 9));
    // Every part done: the lesson is read, and the path now stays on the topic with its exercises, with no part.
    expect(lessonSteps(db, "t1")).toHaveLength(1);
    expect(planGuide(db, "p", now)!.topics.find((topic) => topic.topicId === "t1")!.read).toBe(true);
    expect(next(db)).toMatchObject({ activity: "practice", topicId: "t1" });
    expect(next(db)!.part).toBeUndefined();
    db.close();
  });

  it("suggests a topic without parts as before, whether another topic has an outline or not", () => {
    const results = [false, true].map((outline) => {
      const { db } = workspace(outline);
      // t1 read whole and practised three times, so the path moves on to t2, which has no parts.
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES
           ('l', 'lesson_completed', 'p', 't1', '{"activity":"lesson"}', ?),
           ('a1', 'answer_given', 'p', 't1', '{"score":1,"evidenceKind":"quiz","attemptId":"x1"}', ?),
           ('a2', 'answer_given', 'p', 't1', '{"score":1,"evidenceKind":"quiz","attemptId":"x2"}', ?),
           ('a3', 'answer_given', 'p', 't1', '{"score":1,"evidenceKind":"quiz","attemptId":"x3"}', ?)`,
      ).run(at(-3), at(-2), at(-2, 10), at(-2, 11));
      const value = planGuide(db, "p", now);
      db.close();
      return value;
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[0]!.next).toEqual({ activity: "lesson", topicId: "t2", reason: "next", count: 0 });
  });
});
