import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { IpcError } from "../../shared/ipc";
import { parseSmartText, smartQuestions } from "../../shared/smart-text";
import { createRunner } from "../jobs/runner";
import { examRings, savePlannerHours } from "../plans/planner";
import { planMasteryBreakdown } from "../plans/progress";
import { readSteps, recordStep } from "../plans/steps";
import { topicContent } from "../plans/views";
import { BOOK_VERSION, cacheKey } from "./lesson";
import { oldLesson } from "./oldLessons";
import { PART_JOB, openPart, registerPartJobs, rewriteInParts } from "./partJobs";
import { finishPart } from "./partProgress";
import { liveOutline } from "./parts";
import { partOfText } from "./partText";
import { answerSmartCheck, smartAnswers } from "./smartText";
import { checkBlock, recapMarkdown } from "./test-parts";

// Lessons written before parts: the one rule for finished and unfinished, which mode `study.part` opens them in, the
// rewrite in parts, and what a rewrite keeps of the student's work.

type Db = ReturnType<typeof openDatabase>;

/** A plan with one topic of four passages of 7,000 characters, an engine, and a flashcard made on the topic. */
function seed(db: Db) {
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.exec(`
    INSERT INTO plans (id, title, status, content_language, created_at, updated_at) VALUES ('p', 'Analisi 2', 'ready', 'it', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Funzioni di più variabili', 0, 1);
    INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1);
    INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES ('card', 'p', 't', 'Che cos''è un intorno?', 'Una palla.', 1);
  `);
  for (let index = 1; index <= 4; index++) {
    db.prepare("INSERT INTO passages (id, source_id, text, created_at) VALUES (?, 's', ?, ?)").run(
      `ps${index}`,
      `MARK-${index} `.padEnd(7_000, "x"),
      index,
    );
    db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('t', ?)").run(`ps${index}`);
  }
}

const words = (part: string, count: number) => Array.from({ length: count }, (_, i) => `parola${part}n${i}`).join(" ");
const takeaway = (part: string) => `\`\`\`pyxis-takeaway\n{"text": "Hai imparato il passo ${part}."}\n\`\`\``;
function partText(part: string): string {
  return `Riprendiamo.\n\n## Passo ${part} primo\n\n${words(part, 150)}\n\n## Passo ${part} secondo\n\n${words(part, 150)}\n\n${checkBlock(`Domanda ${part}?`)}\n\n${takeaway(part)}`;
}
function recapText(): string {
  const question = { question: "Quale?", options: ["a", "b", "c"], answer: 0 };
  return `## Riepilogo\n\n- uno\n- due\n- tre\n- quattro\n\n\`\`\`pyxis-recap\n${JSON.stringify({ questions: [question, question, question] })}\n\`\`\`\n\n${takeaway("finale")}`;
}

/** A recorded engine: one part per passage, a sound text for each part, a failure while `fail` is set, a wait on `hold`. */
function engine() {
  const state = { calls: 0, fail: null as Error | null, hold: null as Promise<void> | null };
  const run: GenerateInput["run"] = async (input) => {
    state.calls++;
    if (state.hold) await state.hold;
    input.signal?.throwIfAborted();
    if (state.fail) throw state.fail;
    if (input.responseSchema) {
      const reply = {
        lessonParts: [1, 2, 3, 4].map((n) => ({ title: `Idea ${n}`, about: `Dopo la parte ${n} sai farlo.`, passages: [`P${n}`] })),
      };
      return { structured: reply, text: JSON.stringify(reply), provider: "claude", model: "test-model", inputTokens: 1 };
    }
    const part = /^Part (\d+) of/m.exec(input.prompt)?.[1];
    return { text: part ? partText(part) : recapText(), provider: "claude", model: "test-model", inputTokens: 1 };
  };
  return { state, run };
}

/** The old lesson's text: a section, a quick check, and the closing recap of three questions. */
const oldMarkdown = ["## Intorni", "", "Un intorno è una palla aperta.", "", checkBlock("Che cos'è un intorno?"), "", recapMarkdown("Ripasso")].join(
  "\n",
);
const questionIds = [...smartQuestions(parseSmartText(oldMarkdown)).keys()];

type OldRow = {
  id: string;
  /** Null for book text saved while no engine worked. */
  provider?: string | null;
  /** Null for a lesson imported from a plan file, which records no template. */
  template?: string | null;
  version?: string;
  wording?: string;
  createdAt?: number;
};

/** Saves a lesson written before parts, with a figure and its two citations, as `writeLesson` or a plan import does. */
function saveOld(db: Db, row: OldRow): string {
  const version = row.version ?? "smart-4";
  const book = row.provider === null;
  const key = cacheKey({
    kind: "lesson",
    scopeId: "t",
    passageIds: ["ps1", "ps2"],
    promptVersion: book ? BOOK_VERSION : `${version}|complete-2|${row.wording ?? "balanced"}|university|||it`,
  });
  db.prepare(
    `INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, model_id, prompt_template, prompt_version,
       grounding, created_at)
     VALUES (?, 'p', 't', 'lesson', ?, ?, ?, ?, ?, 'sources', ?)`,
  ).run(
    row.id,
    JSON.stringify({ cacheKey: key, markdown: oldMarkdown, passageIds: ["ps1", "ps2"], figures: { fig: "data:image/png;base64,AA==" } }),
    book ? null : (row.provider ?? "claude"),
    book ? null : "m",
    book || row.template === null ? null : (row.template ?? "lesson.write"),
    book || row.template === null ? null : version,
    row.createdAt ?? 1,
  );
  for (const passage of ["ps1", "ps2"])
    db.prepare("INSERT INTO item_passages (item_id, passage_id) VALUES (?, ?)").run(row.id, passage);
  return row.id;
}

const answer = (db: Db, itemId: string, question: number) =>
  answerSmartCheck(db, { planId: "p", itemId, blockId: questionIds[question]!, pick: 0 });
/** Answers the old lesson's quick check and all three recap questions: the recap records the lesson step. */
const finishThroughRecap = (db: Db, itemId: string) => [0, 1, 2, 3].map((question) => answer(db, itemId, question));

let opened: Db[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of opened) if (db.open) db.close();
  opened = [];
});

function setUp() {
  const db = openDatabase(":memory:");
  opened.push(db);
  seed(db);
  const recorded = engine();
  const runner = createRunner(db, () => {});
  registerPartJobs(db, runner, recorded.run, { python: null });
  return { db, runner, engine: recorded };
}

/** Waits until no part job is queued or running. */
async function settle(db: Db) {
  for (let i = 0; i < 400; i++) {
    if (!db.prepare(`SELECT 1 FROM jobs WHERE kind = '${PART_JOB}' AND state IN ('queued', 'running')`).get()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("part jobs did not settle");
}

const jobStates = (db: Db) =>
  (db.prepare(`SELECT state FROM jobs WHERE kind = '${PART_JOB}' ORDER BY created_at, rowid`).pluck().all() as string[]).join(",");
const lessonSteps = (db: Db) => readSteps(db, "p").filter((step) => step.activity === "lesson" && step.topicId === "t");

/** Everything the student has of the old lesson, to compare before and after a rewrite. */
function kept(db: Db, itemId: string) {
  return {
    row: db.prepare("SELECT body_json, engine_provider, prompt_template, prompt_version, created_at FROM items WHERE id = ?").get(itemId),
    citations: db.prepare("SELECT passage_id FROM item_passages WHERE item_id = ? ORDER BY passage_id").pluck().all(itemId),
    answers: smartAnswers(db, itemId),
    events: db.prepare("SELECT COUNT(*) FROM learning_events WHERE item_id = ?").pluck().get(itemId),
    cards: db.prepare("SELECT id, front, back FROM cards WHERE topic_id = 't'").all(),
    finishedItems: topicContent(db, "p", "t").items.map((item) => item.id),
    steps: lessonSteps(db).map((step) => ({ itemId: step.itemId, at: step.at })),
    checks: planMasteryBreakdown(db, "p").find((topic) => topic.id === "t")?.parts.check.count,
  };
}

describe("the rule for a lesson written before parts", () => {
  it("is none for a topic never opened and for book text saved with no AI tool, which are planned in parts", () => {
    const { db } = setUp();
    expect(oldLesson(db, "p", "t")).toBeNull();
    saveOld(db, { id: "book", provider: null });
    expect(oldLesson(db, "p", "t")).toBeNull();
    // Book text finished with "Fatto" is still no lesson to keep: the topic is planned in parts, its step stays.
    recordStep(db, "p", { activity: "lesson", topicId: "t", itemId: "book" });
    expect(oldLesson(db, "p", "t")).toBeNull();
    expect(openPart(db, undefined, { planId: "p", topicId: "t" })).toMatchObject({ mode: "parts", replaces: null });
  });

  it("is unfinished for a lesson opened and never answered, and for one answered up to the last recap question", () => {
    const { db } = setUp();
    saveOld(db, { id: "old" });
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "old", finished: false });
    answer(db, "old", 0);
    answer(db, "old", 1);
    answer(db, "old", 2);
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "old", finished: false });
  });

  it("is finished through the recap, and through Fatto", () => {
    const recap = setUp();
    saveOld(recap.db, { id: "old" });
    expect(finishThroughRecap(recap.db, "old").at(-1)).toMatchObject({ finished: true });
    expect(oldLesson(recap.db, "p", "t")).toEqual({ itemId: "old", finished: true });

    const done = setUp();
    saveOld(done.db, { id: "old" });
    recordStep(done.db, "p", { activity: "lesson", topicId: "t" });
    expect(oldLesson(done.db, "p", "t")).toEqual({ itemId: "old", finished: true });
  });

  it("is finished when the recap is answered in full even without a step, as a topic archived at the time leaves it", () => {
    const { db } = setUp();
    saveOld(db, { id: "old" });
    for (const blockId of questionIds.slice(1))
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, item_id, payload_json, created_at)
         VALUES (?, 'answer_given', 'p', 't', 'old', ?, 2)`,
      ).run(`e-${blockId}`, JSON.stringify({ blockId, pick: 0, shown: true, score: 1, evidenceKind: "check" }));
    expect(lessonSteps(db)).toEqual([]);
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "old", finished: true });
  });

  it("treats a lesson imported from a plan file and one written by an older prompt as the student's own", () => {
    const { db } = setUp();
    saveOld(db, { id: "imported", template: null, provider: "codex" });
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "imported", finished: false });
    saveOld(db, { id: "older", version: "smart-2", createdAt: 2 });
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "older", finished: false });
    // A plan file with progress carries the lesson step: the imported lesson is finished.
    recordStep(db, "p", { activity: "lesson", topicId: "t", itemId: "imported" });
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "imported", finished: true });
  });

  it("picks, among lessons at several levels, the one the step names, else the one answered last, else the newest", () => {
    const { db } = setUp();
    saveOld(db, { id: "balanced", createdAt: 1 });
    saveOld(db, { id: "simple", wording: "simple", createdAt: 2 });
    saveOld(db, { id: "technical", wording: "technical", createdAt: 3 });
    expect(oldLesson(db, "p", "t")?.itemId).toBe("technical");
    answer(db, "simple", 0);
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "simple", finished: false });
    // The student finished the balanced one with Fatto: that is the lesson they read.
    recordStep(db, "p", { activity: "lesson", topicId: "t", itemId: "balanced" });
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "balanced", finished: true });
  });
});

describe("which reader study.part opens", () => {
  it("rule 1: an old lesson's item opens it in the existing reader, as earlier or as finished", () => {
    const { db, runner } = setUp();
    saveOld(db, { id: "old" });
    expect(openPart(db, runner, { planId: "p", topicId: "t", itemId: "old" })).toEqual({ mode: "legacy", old: "earlier" });
    finishThroughRecap(db, "old");
    expect(openPart(db, runner, { planId: "p", topicId: "t", itemId: "old", write: true })).toEqual({ mode: "legacy", old: "finished" });
    expect(jobStates(db)).toBe("");
  });

  it("rule 3: a finished old lesson opens as it is, starts nothing, and keeps the step's place", () => {
    const { db, runner, engine } = setUp();
    saveOld(db, { id: "old" });
    finishThroughRecap(db, "old");
    expect(openPart(db, runner, { planId: "p", topicId: "t", write: true })).toEqual({ mode: "legacy", old: "finished" });
    expect(openPart(db, runner, { planId: "p", topicId: "t", position: 1, write: true })).toEqual({ mode: "legacy", old: "finished" });
    expect(jobStates(db)).toBe("");
    expect(engine.state.calls).toBe(0);
  });

  it("rule 4: an unfinished old lesson is rewritten in parts once, on its first open, and names the old lesson", async () => {
    const { db, runner, engine } = setUp();
    saveOld(db, { id: "old" });
    answer(db, "old", 0);
    // Reading only starts nothing, so a page that polls never starts a rewrite.
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({
      mode: "parts",
      outline: null,
      state: "failed",
      error: null,
      replaces: { itemId: "old" },
    });
    expect(jobStates(db)).toBe("");
    expect(openPart(db, runner, { planId: "p", topicId: "t", write: true })).toMatchObject({
      mode: "parts",
      state: "planning",
      replaces: { itemId: "old" },
    });
    await settle(db);
    expect(liveOutline(db, "t")?.replacesItemId).toBe("old");
    const part = openPart(db, runner, { planId: "p", topicId: "t", write: true });
    expect(part).toMatchObject({ mode: "parts", position: 1, state: "written", replaces: { itemId: "old" } });
    // The answer on the old text is no part done.
    expect(part.mode === "parts" && part.outline).toMatchObject({ teaching: 4, done: 0 });
    await settle(db);
    // Opening again writes no new outline: the plan, part 1 and the one part ahead.
    expect(db.prepare("SELECT COUNT(*) FROM lesson_outlines").pluck().get()).toBe(1);
    expect(engine.state.calls).toBe(3);
    expect(openPart(db, runner, { planId: "p", topicId: "t", itemId: "old" })).toEqual({ mode: "legacy", old: "earlier" });
  });

  it("rules 2 and 5: a topic with an outline opens its parts, and one with no old lesson is planned without one", () => {
    const { db, runner } = setUp();
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ mode: "parts", replaces: null });
    db.exec(`INSERT INTO lesson_outlines (id, plan_id, topic_id, passage_key, origin, created_at) VALUES ('o', 'p', 't', 'k', 'model', 1);
      INSERT INTO lesson_parts (id, outline_id, position, kind, title, minutes) VALUES ('o-1', 'o', 1, 'part', 'Uno', 5);`);
    // An old lesson saved after the topic was planned does not take the topic back.
    saveOld(db, { id: "old" });
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ mode: "parts", replaces: null });
  });

  it("names the old lesson only while its row is there", () => {
    const { db, runner } = setUp();
    saveOld(db, { id: "old" });
    db.exec(`INSERT INTO lesson_outlines (id, plan_id, topic_id, passage_key, origin, replaces_item_id, created_at)
        VALUES ('o', 'p', 't', 'k', 'model', 'old', 1);
      INSERT INTO lesson_parts (id, outline_id, position, kind, title, minutes) VALUES ('o-1', 'o', 1, 'part', 'Uno', 5);`);
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ replaces: { itemId: "old" } });
    db.exec("DELETE FROM item_passages WHERE item_id = 'old'; DELETE FROM items WHERE id = 'old'");
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ replaces: null });
  });
});

describe("a rewrite keeps everything the student made", () => {
  it("of an unfinished lesson: text, figures, citations, answers, flashcards, its place and the mastery it gave", async () => {
    const { db, runner } = setUp();
    saveOld(db, { id: "old" });
    answer(db, "old", 0);
    answer(db, "old", 1);
    const before = kept(db, "old");
    expect(before.checks).toBe(2);
    expect(before.finishedItems).toEqual(["old"]);
    openPart(db, runner, { planId: "p", topicId: "t", write: true });
    await settle(db);
    openPart(db, runner, { planId: "p", topicId: "t", write: true });
    await settle(db);
    expect(liveOutline(db, "t")?.parts.filter((part) => part.itemId)).toHaveLength(2);
    // The parts are no finished items of their own, and the old lesson's answers count until the parts get theirs.
    expect(kept(db, "old")).toEqual(before);
    expect(lessonSteps(db)).toEqual([]);
  });

  it("of a finished lesson: the step stays, the parts start not done, and reading them all adds no second step", async () => {
    const { db, runner } = setUp();
    saveOld(db, { id: "old" });
    finishThroughRecap(db, "old");
    const before = kept(db, "old");
    expect(before.steps).toHaveLength(1);
    expect(rewriteInParts(db, runner, { planId: "p", topicId: "t" })).toEqual({ ok: true });
    // While part 1 is written the topic opens in parts, with the old lesson named.
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ mode: "parts", state: "planning", replaces: { itemId: "old" } });
    await settle(db);
    const outline = liveOutline(db, "t")!;
    expect(outline.replacesItemId).toBe("old");
    expect(outline.parts.every((part) => part.doneAt === null)).toBe(true);
    expect(oldLesson(db, "p", "t")).toEqual({ itemId: "old", finished: true });
    expect(kept(db, "old")).toEqual(before);
    // Every part read to the end: the parts are done, the topic keeps its one step, named by the old lesson.
    db.transaction(() => {
      for (const part of outline.parts) finishPart(db, { partId: part.id, outlineId: outline.id, position: part.position }, 10);
    })();
    expect(lessonSteps(db).map((step) => step.itemId)).toEqual(["old"]);
    // The part item's answers are its own: a part item is no old lesson.
    const first = liveOutline(db, "t")!.parts[0]!.itemId!;
    expect(partOfText(db, first)).not.toBeNull();
    expect(oldLesson(db, "p", "t")?.itemId).toBe("old");
  });

  it("counts today's minutes once: a finished lesson's 30 and its parts read again, or only the parts of an unfinished one", async () => {
    // Only the date is fixed, at noon, so the day cannot turn during the test; the jobs' timers still run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 13, 12));
    /** Today's minutes on the exam's ring, with the exam a month away and six hours a week. */
    const today = (db: Db) => {
      db.prepare("UPDATE plans SET exam_at = ? WHERE id = 'p'").run(Date.now() + 30 * 86_400_000);
      savePlannerHours(db, { hours: 6 }, Date.now());
      return examRings(db).find((ring) => ring.planId === "p")?.todayMinutes?.done;
    };
    const readAll = (db: Db) => {
      const outline = liveOutline(db, "t")!;
      db.transaction(() => {
        for (const part of outline.parts)
          finishPart(db, { partId: part.id, outlineId: outline.id, position: part.position }, Date.now());
      })();
      return outline.parts.reduce((sum, part) => sum + part.minutes, 0);
    };

    // Finished today and rewritten: its step names the old lesson, read whole, and keeps its 30 beside the parts.
    const finished = setUp();
    saveOld(finished.db, { id: "old" });
    finishThroughRecap(finished.db, "old");
    expect(today(finished.db)).toBe(30);
    rewriteInParts(finished.db, finished.runner, { planId: "p", topicId: "t" });
    await settle(finished.db);
    const parts = readAll(finished.db);
    expect(lessonSteps(finished.db).map((step) => step.itemId)).toEqual(["old"]);
    expect(today(finished.db)).toBe(30 + parts);

    // Unfinished and rewritten when opened: the step its last part records names a part's text and adds nothing.
    const unfinished = setUp();
    saveOld(unfinished.db, { id: "old" });
    answer(unfinished.db, "old", 0);
    openPart(unfinished.db, unfinished.runner, { planId: "p", topicId: "t", write: true });
    await settle(unfinished.db);
    const read = readAll(unfinished.db);
    const step = lessonSteps(unfinished.db)[0]!;
    expect(step.itemId).toBe(liveOutline(unfinished.db, "t")!.parts[0]!.itemId);
    expect(today(unfinished.db)).toBe(read);
  });

  it("refuses a topic already in parts and one with no old lesson", async () => {
    const { db, runner } = setUp();
    expect(() => rewriteInParts(db, runner, { planId: "p", topicId: "t" })).toThrow("lesson-missing");
    saveOld(db, { id: "old" });
    finishThroughRecap(db, "old");
    rewriteInParts(db, runner, { planId: "p", topicId: "t" });
    await settle(db);
    expect(() => rewriteInParts(db, runner, { planId: "p", topicId: "t" })).toThrow("parts-exist");
    expect(() => rewriteInParts(db, runner, { planId: "p", topicId: "other" })).toThrow("topic-missing");
  });
});

describe("a rewrite that does not finish leaves the old lesson as it was", () => {
  async function failed(setUpFailure: (db: Db, recorded: ReturnType<typeof engine>) => void) {
    const { db, runner, engine } = setUp();
    saveOld(db, { id: "old" });
    answer(db, "old", 0);
    const before = kept(db, "old");
    setUpFailure(db, engine);
    openPart(db, runner, { planId: "p", topicId: "t", write: true });
    await settle(db);
    expect(liveOutline(db, "t")).toBeNull();
    expect(kept(db, "old")).toEqual(before);
    return { db, runner, engine };
  }

  it("on an engine error: the page gets the error and the old lesson, and Riprova rewrites it", async () => {
    const { db, runner, engine } = await failed((_, recorded) => {
      recorded.state.fail = new IpcError("cli-failed", "engines.errors.cli-failed", { provider: "claude" }, "exit 1");
    });
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({
      mode: "parts",
      state: "failed",
      error: "cli-failed [claude]: exit 1",
      replaces: { itemId: "old" },
    });
    engine.state.fail = null;
    openPart(db, runner, { planId: "p", topicId: "t", position: 1, write: true });
    await settle(db);
    expect(liveOutline(db, "t")?.replacesItemId).toBe("old");
  });

  it("with no AI tool set up", async () => {
    const { db, runner } = await failed((db) => db.exec("DELETE FROM feature_engines"));
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({
      mode: "parts",
      state: "book",
      replaces: { itemId: "old" },
    });
  });

  it("on a cancel: an unfinished lesson is rewritten on its next open, a finished one opens as it was", async () => {
    const { db, runner, engine } = setUp();
    saveOld(db, { id: "old" });
    let release = () => {};
    engine.state.hold = new Promise<void>((resolve) => (release = resolve));
    openPart(db, runner, { planId: "p", topicId: "t", write: true });
    runner.cancel(db.prepare(`SELECT id FROM jobs WHERE kind = '${PART_JOB}'`).pluck().get() as string);
    release();
    await settle(db);
    expect(jobStates(db)).toBe("cancelled");
    expect(liveOutline(db, "t")).toBeNull();
    // The page's first read then starts it again (`startsOnOpen`): nothing failed that the student has to see.
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ mode: "parts", state: "failed", error: null });

    finishThroughRecap(db, "old");
    expect(openPart(db, runner, { planId: "p", topicId: "t", position: 1 })).toEqual({ mode: "legacy", old: "finished" });
  });

  it("of a lesson finished after its rewrite saved a plan and failed: it opens as it was, and Riscrivi in parti retries", async () => {
    const { db, runner, engine } = setUp();
    saveOld(db, { id: "old" });
    // A topic of one passage is one part: its plan is saved by code, then the write fails.
    db.exec("DELETE FROM topic_passages WHERE passage_id IN ('ps2', 'ps3', 'ps4')");
    engine.state.fail = new IpcError("cli-failed", "engines.errors.cli-failed", { provider: "claude" }, "exit 1");
    openPart(db, runner, { planId: "p", topicId: "t", write: true });
    await settle(db);
    expect(liveOutline(db, "t")?.replacesItemId).toBe("old");
    expect(openPart(db, runner, { planId: "p", topicId: "t", position: 1 })).toMatchObject({ mode: "parts", state: "failed" });
    // The student finishes the old lesson shown in its place.
    finishThroughRecap(db, "old");
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toEqual({ mode: "legacy", old: "finished" });
    expect(openPart(db, runner, { planId: "p", topicId: "t", itemId: "old" })).toEqual({ mode: "legacy", old: "finished" });
    engine.state.fail = null;
    rewriteInParts(db, runner, { planId: "p", topicId: "t" });
    await settle(db);
    expect(db.prepare("SELECT COUNT(*) FROM lesson_outlines").pluck().get()).toBe(1);
    expect(liveOutline(db, "t")?.parts[0]?.itemId).not.toBeNull();
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ mode: "parts", state: "written" });
    expect(openPart(db, runner, { planId: "p", topicId: "t", itemId: "old" })).toEqual({ mode: "legacy", old: "earlier" });
    expect(() => rewriteInParts(db, runner, { planId: "p", topicId: "t" })).toThrow("parts-exist");
  });

  it("of a finished lesson: the page that asked for parts keeps the failure, any other open shows the lesson as it was", async () => {
    const { db, runner, engine } = setUp();
    saveOld(db, { id: "old" });
    finishThroughRecap(db, "old");
    engine.state.fail = new IpcError("cli-failed", "engines.errors.cli-failed", { provider: "claude" }, "exit 1");
    rewriteInParts(db, runner, { planId: "p", topicId: "t" });
    await settle(db);
    expect(openPart(db, runner, { planId: "p", topicId: "t", position: 1 })).toMatchObject({
      mode: "parts",
      state: "failed",
      replaces: { itemId: "old" },
    });
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toEqual({ mode: "legacy", old: "finished" });
    engine.state.fail = null;
    openPart(db, runner, { planId: "p", topicId: "t", position: 1, write: true });
    await settle(db);
    expect(liveOutline(db, "t")?.replacesItemId).toBe("old");
    expect(lessonSteps(db)).toHaveLength(1);
  });
});
