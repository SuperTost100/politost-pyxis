import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { createRunner } from "../jobs/runner";
import { exportPlan } from "../plans/file";
import { planFootprint } from "../plans/settings";
import { topicContent } from "../plans/views";
import { parseSmartText, smartQuestions, smartSections } from "../../shared/smart-text";
import { CONTEXT_CHARS } from "./openLesson";
import { oldLesson } from "./oldLessons";
import { itemWording, liveOutline, partShape, rewritePartSection } from "./parts";
import { PART_JOB, openPart, registerPartJobs, type PartResult } from "./partJobs";
import { partsDoneSince } from "./partProgress";
import { answerSmartCheck, smartAnswers } from "./smartText";

// The level of a part and its rewrites: "Livello" on a part writes it again at the chosen level and keeps the level for
// the parts after it, "Riscrivi questa parte" writes it again at its own level, and a section of a part is rewritten
// in the part's shape. Every text of a part stays the part's, and a part done stays done.

type Db = ReturnType<typeof openDatabase>;

/** A plan with one topic of four passages of 7,000 characters, planned in four parts, and an engine. */
function seed(db: Db) {
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.exec(`
    INSERT INTO plans (id, title, status, content_language, created_at, updated_at) VALUES ('p', 'Analisi 2', 'ready', 'it', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Funzioni di più variabili', 0, 1);
    INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1);
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

const words = (tag: string, count: number) => Array.from({ length: count }, (_, i) => `parola${tag}n${i}`).join(" ");
const check = (tag: string) =>
  `\`\`\`pyxis-check\n${JSON.stringify({ question: `Domanda ${tag}?`, options: ["uno", "due", "tre"], answer: 1, explanation: "Perché." })}\n\`\`\``;
const takeaway = (tag: string) => `\`\`\`pyxis-takeaway\n{"text": "Hai imparato ${tag}."}\n\`\`\``;

/** A sound part, tagged with its number and the level it was asked at, so a test can tell its texts apart. */
function partText(tag: string, length = 150): string {
  return `Riprendiamo.\n\n## Passo ${tag} primo\n\n${words(tag, length)}\n\n## Passo ${tag} secondo\n\n${words(tag, length)}\n\n${check(tag)}\n\n${takeaway(tag)}`;
}

function recapText(tag: string): string {
  const question = { question: "Quale?", options: ["a", "b", "c"], answer: 0 };
  return `## Riepilogo\n\n- uno\n- due\n\n\`\`\`pyxis-recap\n${JSON.stringify({ questions: [question, question, question] })}\n\`\`\`\n\n${takeaway(tag)}`;
}

/**
 * A recorded engine. The outline call gives one passage per part; a part call answers with a sound part tagged
 * `<part>-<level>-<n>` (the n-th text of that part), or `reply` when a test sets one; `fail` makes a part's call throw.
 * `hold("<part>:<level>")` keeps the next call for that part at that level waiting until it is released.
 */
function engine() {
  const calls: Array<{ part: string; wording: string; prompt: string }> = [];
  const fails = new Map<string, Error>();
  const replies: string[] = [];
  const holds = new Map<string, Array<Promise<void>>>();
  const run: GenerateInput["run"] = async (input) => {
    if (input.responseSchema) {
      const reply = {
        lessonParts: [1, 2, 3, 4].map((n) => ({ title: `Idea ${n}`, about: `Dopo la parte ${n} sai farlo.`, passages: [`P${n}`] })),
      };
      return { structured: reply, text: JSON.stringify(reply), provider: "claude", model: "m", inputTokens: 1 };
    }
    const part = /^Part (\d+) of/m.exec(input.prompt)?.[1] ?? "recap";
    const wording = /Wording: (\w+)/.exec(input.system ?? "")?.[1] ?? "?";
    calls.push({ part, wording, prompt: input.prompt });
    await holds.get(`${part}:${wording}`)?.shift();
    const fail = fails.get(part);
    if (fail) throw fail;
    const next = replies.shift();
    if (next !== undefined) return { text: next, provider: "claude", model: "m", inputTokens: 1 };
    const tag = `${part}-${wording}-${calls.filter((call) => call.part === part).length}`;
    return { text: part === "recap" ? recapText(tag) : partText(tag), provider: "claude", model: "m", inputTokens: 1 };
  };
  return {
    calls,
    run,
    fail: (part: string, error: Error | null) => (error ? fails.set(part, error) : fails.delete(part)),
    reply: (...texts: string[]) => replies.push(...texts),
    hold(key: string) {
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      holds.set(key, [...(holds.get(key) ?? []), gate]);
      return release;
    },
    /** Waits until a call for `<part>:<level>` has come in `count` times. */
    async called(key: string, count = 1) {
      for (let i = 0; i < 400; i++) {
        if (calls.filter((call) => `${call.part}:${call.wording}` === key).length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`no call for ${key}`);
    },
  };
}

let open: Db[] = [];
afterEach(() => {
  for (const db of open) if (db.open) db.close();
  open = [];
});

function setUp() {
  const db = openDatabase(":memory:");
  open.push(db);
  seed(db);
  const recorded = engine();
  const runner = createRunner(db, () => {}, undefined, false);
  registerPartJobs(db, runner, recorded.run, { python: null });
  return { db, runner, engine: recorded };
}

async function settle(db: Db) {
  for (let i = 0; i < 400; i++) {
    if (!db.prepare(`SELECT 1 FROM jobs WHERE kind = '${PART_JOB}' AND state IN ('queued', 'running')`).get()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("part jobs did not settle");
}

type Parts = Extract<PartResult, { mode: "parts" }>;
const read = (db: Db, runner: ReturnType<typeof createRunner>, position: number, more: Record<string, unknown> = {}) =>
  openPart(db, runner, { planId: "p", topicId: "t", position, ...more }) as Parts;

/** The tag of the text a part shows: which part, at which level, which write. */
function shown(db: Db, position: number): string | null {
  const itemId = liveOutline(db, "t")!.parts.find((part) => part.position === position)!.itemId;
  if (!itemId) return null;
  const markdown = db.prepare("SELECT json_extract(body_json, '$.markdown') FROM items WHERE id = ?").pluck().get(itemId) as string;
  return /## Passo (\S+) primo/.exec(markdown)?.[1] ?? null;
}

const part = (db: Db, position: number) => liveOutline(db, "t")!.parts.find((entry) => entry.position === position)!;

/** Opens part 1, answers it, and opens part 2: parts 1 and 2 written at the profile's level, part 3 written ahead. */
async function readToPartTwo(db: Db, runner: ReturnType<typeof createRunner>, now = Date.now()) {
  read(db, runner, 1, { write: true });
  await settle(db);
  read(db, runner, 1);
  await settle(db);
  const first = read(db, runner, 1);
  const question = [...smartQuestions(parseSmartText(first.lesson!.markdown)).keys()][0]!;
  answerSmartCheck(db, { planId: "p", itemId: first.lesson!.itemId!, blockId: question, pick: 1 }, now);
  read(db, runner, 2);
  await settle(db);
}

describe("the level of a part", () => {
  it("writes the part again at the level chosen, and the parts after it follow that level", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    expect([shown(db, 1), shown(db, 2), shown(db, 3)]).toEqual(["1-balanced-1", "2-balanced-1", "3-balanced-1"]);
    const doneAt = part(db, 1).doneAt;
    const earlier = part(db, 2).itemId!;

    // "Semplice" on part 2: its job starts, and the page keeps the text it had until the new one is saved.
    const writing = read(db, runner, 2, { wording: "simple" });
    expect(writing.rewrite).toMatchObject({ state: "writing", rewrite: "level", wording: "simple" });
    expect(writing.lesson?.itemId).toBe(earlier);
    await settle(db);

    const after = read(db, runner, 2);
    expect(after.rewrite).toBeNull();
    expect(shown(db, 2)).toBe("2-simple-2");
    expect(after.lesson?.wording).toBe("simple");
    expect(after.summary).toBe("Hai imparato 2-simple-2.");
    expect(liveOutline(db, "t")!.wording).toBe("simple");
    // Part 3, written ahead at the earlier level and not read, is written again as the part ahead of part 2.
    await settle(db);
    expect(shown(db, 3)).toBe("3-simple-2");
    // Part 1, done before the change, keeps its text and stays done.
    expect(shown(db, 1)).toBe("1-balanced-1");
    expect(part(db, 1).doneAt).toBe(doneAt);
    // Part 4, written for the first time after the change, is written at the level chosen.
    read(db, runner, 4, { write: true });
    await settle(db);
    expect(shown(db, 4)).toBe("4-simple-1");
    // One call for the change, one for the part ahead; the earlier text of part 2 is still there, and still its own.
    expect(engine.calls.map((call) => `${call.part}:${call.wording}`)).toEqual([
      "1:balanced",
      "2:balanced",
      "3:balanced",
      "2:simple",
      "3:simple",
      "4:simple",
    ]);
    expect(itemWording(db, earlier)).toBe("balanced");
  });

  it("shows a text written at a level before with no call, with its summary, and opens an earlier text as its part", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const balanced = part(db, 2).itemId!;
    read(db, runner, 2, { wording: "technical" });
    await settle(db);
    const calls = engine.calls.length;

    const back = read(db, runner, 2, { wording: "balanced" });
    expect(back.rewrite).toBeNull();
    expect(back.lesson?.itemId).toBe(balanced);
    expect(back.summary).toBe("Hai imparato 2-balanced-1.");
    expect(liveOutline(db, "t")!.wording).toBe("balanced");
    // Choosing the level the part is at changes nothing and calls nothing.
    expect(read(db, runner, 2, { wording: "balanced" }).lesson?.itemId).toBe(balanced);
    await settle(db);
    expect(engine.calls.slice(calls).map((call) => call.part)).toEqual([]);

    // The technical text, opened by its item (as a finished step names it), opens as part 2.
    const technical = db
      .prepare("SELECT id FROM items WHERE prompt_template = 'lesson.part' AND body_json LIKE '%2-technical-2%'")
      .pluck()
      .get() as string;
    const opened = openPart(db, runner, { planId: "p", topicId: "t", itemId: technical }) as Parts;
    expect(opened).toMatchObject({ mode: "parts", position: 2 });
  });

  it("keeps the earlier text and its level when writing the part again fails, and Riprova writes it", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const earlier = part(db, 2).itemId!;
    engine.fail("2", new Error("engine down"));
    read(db, runner, 2, { wording: "simple" });
    await settle(db);
    const failed = read(db, runner, 2);
    expect(failed.rewrite).toMatchObject({ state: "failed", rewrite: "level", wording: "simple" });
    expect(failed.rewrite?.error).toContain("engine down");
    expect(failed.lesson?.itemId).toBe(earlier);
    expect(failed.lesson?.wording).toBe("balanced");
    // The level is kept only with the text written at it, so nothing ahead follows a level the student cannot read.
    expect(liveOutline(db, "t")!.wording).toBeNull();
    const jobs = db.prepare(`SELECT COUNT(*) FROM jobs WHERE kind = '${PART_JOB}'`).pluck().get();

    // Riprova sends the same choice again: the failed job is retried, not doubled.
    engine.fail("2", null);
    read(db, runner, 2, { wording: "simple" });
    await settle(db);
    expect(db.prepare(`SELECT COUNT(*) FROM jobs WHERE kind = '${PART_JOB}'`).pluck().get()).toBe(jobs);
    expect(read(db, runner, 2).rewrite).toBeNull();
    expect(shown(db, 2)).toBe("2-simple-3");
  });

  it("leaves a part ahead whose rewrite failed for the student", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    engine.fail("3", new Error("engine down"));
    read(db, runner, 2, { wording: "simple" });
    await settle(db);
    read(db, runner, 2);
    await settle(db);
    const tries = engine.calls.filter((call) => call.part === "3").length;
    // Opening part 2 again does not try part 3 again in the background.
    read(db, runner, 2);
    await settle(db);
    expect(engine.calls.filter((call) => call.part === "3")).toHaveLength(tries);
    const third = read(db, runner, 3);
    expect(third.state).toBe("written");
    expect(third.rewrite).toMatchObject({ state: "failed", wording: "simple" });
    expect(shown(db, 3)).toBe("3-balanced-1");
  });
});

describe("Riscrivi questa parte", () => {
  it("writes the part again at its level in its own item, opens the question again, and a part done stays done", async () => {
    const { db, runner } = setUp();
    const now = Date.now();
    await readToPartTwo(db, runner, now);
    const before = part(db, 1);
    const old = read(db, runner, 1);
    const oldQuestion = [...smartQuestions(parseSmartText(old.lesson!.markdown)).keys()][0]!;
    expect(smartAnswers(db, old.lesson!.itemId!)[oldQuestion]).toBe(1);
    const minutesToday = partsDoneSince(db, "p", now - 1000);

    read(db, runner, 1, { regenerate: true });
    await settle(db);
    const again = read(db, runner, 1);
    expect(shown(db, 1)).toBe("1-balanced-2");
    // The same item: its earlier answer stays under the earlier question's id, and the new question is open.
    expect(again.lesson!.itemId).toBe(before.itemId);
    const question = [...smartQuestions(parseSmartText(again.lesson!.markdown)).keys()][0]!;
    expect(question).not.toBe(oldQuestion);
    expect(smartAnswers(db, again.lesson!.itemId!)).toEqual({ [oldQuestion]: 1 });
    expect(again.summary).toBe("Hai imparato 1-balanced-2.");
    // Done stays done, with the time and minutes it was counted with, so today's minutes count the part once.
    expect(part(db, 1)).toMatchObject({ doneAt: before.doneAt, minutes: before.minutes });
    expect(partsDoneSince(db, "p", now - 1000)).toEqual(minutesToday);
    // Answering the new question finishes nothing a second time.
    const answer = answerSmartCheck(db, { planId: "p", itemId: again.lesson!.itemId!, blockId: question, pick: 1 }, now + 1);
    expect(answer).toMatchObject({ partDone: true, finished: false });
    expect(partsDoneSince(db, "p", now - 1000)).toEqual(minutesToday);
    expect(liveOutline(db, "t")!.wording).toBeNull();
  });

  it("keeps a part's new minutes when it is not done", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const minutes = part(db, 2).minutes;
    engine.reply(partText("lunga", 600));
    read(db, runner, 2, { regenerate: true });
    await settle(db);
    expect(part(db, 2).minutes).toBeGreaterThan(minutes);
    expect(part(db, 2).doneAt).toBeNull();
  });
});

describe("a section rewritten in a part", () => {
  it("keeps the part's question and shape, and takes the new summary", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const before = read(db, runner, 2).lesson!;
    engine.reply(`## Passo nuovo secondo\n\n${words("nuovo", 150)}\n\n${check("nuova")}\n\n${takeaway("la sezione nuova")}`);
    const result = await rewritePartSection(db, { planId: "p", topicId: "t", position: 2, section: 1, run: engine.run, python: null });
    expect(result.itemId).toBe(before.itemId);
    expect(result.markdown).toContain("## Passo 2-balanced-1 primo");
    expect(result.markdown).toContain("## Passo nuovo secondo");
    expect(result.markdown).not.toContain("pyxis-takeaway");
    const questions = [...smartQuestions(parseSmartText(result.markdown)).values()];
    expect(questions.map((question) => question.question)).toEqual(["Domanda nuova?"]);
    expect(part(db, 2).summary).toBe("Hai imparato la sezione nuova.");
    // The request carried the whole part and only this part's material.
    const sent = engine.calls.at(-1)!.prompt;
    expect(sent).toContain('Rewrite only the section "Passo 2-balanced-1 secondo"');
    expect(sent).toContain("MARK-2");
    expect(sent).not.toContain("MARK-3");
  });

  it("asks again when the section lost the part's question, and changes nothing when the second reply lost it too", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const before = read(db, runner, 2).lesson!.markdown;
    const summary = part(db, 2).summary;
    const calls = engine.calls.length;
    engine.reply(
      `## Passo senza domanda\n\n${words("senza", 150)}\n\n${takeaway("niente")}`,
      `## Passo ancora senza\n\n${words("ancora", 150)}`,
    );
    await expect(
      rewritePartSection(db, { planId: "p", topicId: "t", position: 2, section: 1, run: engine.run, python: null }),
    ).rejects.toThrow("lesson-part-invalid");
    expect(engine.calls.length - calls).toBe(2);
    expect(engine.calls.at(-1)!.prompt).toContain("Problems with your previous reply");
    expect(read(db, runner, 2).lesson!.markdown).toBe(before);
    expect(part(db, 2).summary).toBe(summary);
  });

  it("keeps both asks within the request bound for a long part under a long title, and still sends the section", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    // A part of 800 long words, about 30,000 characters, in a topic whose title is 5,000.
    const long = partText("x".repeat(30), 400);
    expect(long.length).toBeGreaterThan(CONTEXT_CHARS);
    db.prepare("UPDATE items SET body_json = json_set(body_json, '$.markdown', ?) WHERE id = ?").run(long, part(db, 2).itemId);
    db.prepare("UPDATE topics SET title = ? WHERE id = 't'").run("Funzioni ".repeat(560));
    const calls = engine.calls.length;
    engine.reply(
      `## Passo senza domanda\n\n${words("senza", 150)}\n\n${takeaway("niente")}`,
      `## Passo nuovo secondo\n\n${words("nuovo", 150)}\n\n${check("nuova")}\n\n${takeaway("la sezione nuova")}`,
    );
    const result = await rewritePartSection(db, { planId: "p", topicId: "t", position: 2, section: 1, run: engine.run, python: null });
    expect(result.markdown).toContain("## Passo nuovo secondo");
    const target = smartSections(long)[1]!;
    const section = long.split("\n").slice(target.start, target.end).join("\n");
    const sent = engine.calls.slice(calls).map((call) => call.prompt);
    expect(sent).toHaveLength(2);
    for (const prompt of sent) {
      expect(prompt.length).toBeLessThanOrEqual(CONTEXT_CHARS);
      // The section to rewrite is sent whole, with the other section's heading and this part's material.
      expect(prompt).toContain(section);
      expect(prompt).toContain(`## Passo ${"x".repeat(30)} primo`);
      expect(prompt).toContain("MARK-2");
    }
  });

  it("refuses a part that is not written", async () => {
    const { db, runner, engine } = setUp();
    read(db, runner, 1, { write: true });
    await settle(db);
    await expect(
      rewritePartSection(db, { planId: "p", topicId: "t", position: 4, section: 0, run: engine.run, python: null }),
    ).rejects.toThrow("lesson-missing");
  });
});

describe("a part written at two levels is one part", () => {
  it("in the topic's finished items, the delete count, plan files and the rule for lessons written before parts", async () => {
    const { db, runner } = setUp();
    await readToPartTwo(db, runner);
    const earlier = part(db, 1).itemId!;
    read(db, runner, 1, { wording: "technical" });
    await settle(db);
    expect(part(db, 1).itemId).not.toBe(earlier);
    // Both texts of part 1 exist, beside parts 2 and 3; the answer was given on the earlier one.
    expect(db.prepare("SELECT COUNT(*) FROM items WHERE prompt_template = 'lesson.part'").pluck().get()).toBe(4);
    expect(db.prepare("SELECT COUNT(*) FROM learning_events WHERE item_id = ?").pluck().get(earlier)).toBe(1);

    // Each place on its own, so a failure names every place that counts the earlier text as a lesson.
    expect.soft(topicContent(db, "p", "t").items.filter((item) => item.kind === "lesson")).toEqual([]);
    expect.soft(planFootprint(db, "p").lessons).toBe(1);
    const file = exportPlan(db, "p", { progress: true });
    expect.soft(file.items ?? []).toEqual([]);
    expect.soft((file.progress ?? []).filter((row) => row.kind === "answer_given")).toEqual([]);
    // The earlier text has an engine and an answer, as a lesson written before parts has, and is still no such lesson.
    expect.soft(oldLesson(db, "p", "t")).toBeNull();
  });
});

// After the review of #427.

/** Waits until a job of the runner is no longer queued or running. */
async function finished(db: Db, jobId: string) {
  for (let i = 0; i < 400; i++) {
    const state = db.prepare("SELECT state FROM jobs WHERE id = ?").pluck().get(jobId) as string;
    if (state !== "queued" && state !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not finish`);
}

const newestJob = (db: Db, position: number) =>
  db
    .prepare(
      `SELECT id, params_json FROM jobs WHERE kind = '${PART_JOB}' AND json_extract(params_json, '$.position') = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(position) as { id: string; params_json: string };

describe("a level chosen while the part ahead is written again", () => {
  /**
   * Part 2 at "simple" makes part 3 the part ahead at the earlier level; its rewrite at "simple" is held while the
   * student picks "technical" on part 2, and the two saves land in `order`.
   */
  async function race(order: "ahead first" | "choice first") {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    read(db, runner, 2, { wording: "simple" });
    await settle(db);
    const releaseAhead = engine.hold("3:simple");
    read(db, runner, 2);
    await engine.called("3:simple", 1);
    const ahead = newestJob(db, 3);
    // The ahead job carries its mark in its stored parameters, so a retry or a resume keeps it.
    expect(JSON.parse(ahead.params_json)).toMatchObject({ rewrite: "level", wording: "simple", ahead: true });
    const releaseChoice = engine.hold("2:technical");
    read(db, runner, 2, { wording: "technical" });
    await engine.called("2:technical", 1);
    const choice = newestJob(db, 2);
    const [first, second] = order === "ahead first" ? [[releaseAhead, ahead.id], [releaseChoice, choice.id]] as const : [[releaseChoice, choice.id], [releaseAhead, ahead.id]] as const;
    first[0]();
    expect(await finished(db, first[1])).toBe("succeeded");
    second[0]();
    expect(await finished(db, second[1])).toBe("succeeded");
    // The student's choice stands, whichever save came last.
    expect(liveOutline(db, "t")!.wording).toBe("technical");
    expect(shown(db, 2)).toBe("2-technical-3");
    // Part 3 was written at a level the outline no longer has: it is written again at the chosen one when reached.
    expect(shown(db, 3)).toBe("3-simple-2");
    read(db, runner, 2);
    await settle(db);
    expect(shown(db, 3)).toBe("3-technical-3");
  }

  it("keeps the student's level when the part ahead saves first", async () => {
    await race("ahead first");
  });

  it("keeps the student's level when the part ahead saves last", async () => {
    await race("choice first");
  });

  it("writes again a part reached at a level the outline no longer has, and not a part before the level was chosen", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    read(db, runner, 2, { wording: "simple" });
    await settle(db);
    // Part 3 is written ahead at "simple"; then the outline moves to "technical" from part 2.
    read(db, runner, 2);
    await settle(db);
    expect(shown(db, 3)).toBe("3-simple-2");
    const releaseChoice = engine.hold("2:technical");
    read(db, runner, 2, { wording: "technical" });
    await engine.called("2:technical");
    // Opening part 3 while part 2 is still written starts nothing: the outline keeps "simple" until part 2's new text is
    // saved, and part 3 is at "simple".
    read(db, runner, 3);
    expect(newestJob(db, 3).params_json).not.toContain("technical");
    releaseChoice();
    await settle(db);
    // Reached now, straight from the path: written again at "technical".
    const reached = read(db, runner, 3);
    expect(reached.rewrite).toMatchObject({ state: "writing", wording: "technical" });
    await settle(db);
    expect(shown(db, 3)).toBe("3-technical-3");
    // Part 1, done at the earlier level, keeps its text when opened.
    read(db, runner, 1);
    await settle(db);
    expect(shown(db, 1)).toBe("1-balanced-1");
  });
});

describe("a part's question stays its last block", () => {
  const trailing = (tag: string) =>
    `## Passo ${tag} primo\n\n${words(tag, 150)}\n\n## Passo ${tag} secondo\n\n${words(tag, 150)}\n\n${check(tag)}\n\nE ancora una frase dopo la domanda.\n\n${takeaway(tag)}`;

  it("is refused on the second reply when the question is not the last block, and accepted with no question", () => {
    const context = { kind: "part" as const, headings: [], last: true };
    expect(partShape(trailing("a"), context).ok).toBe(false);
    const none = partShape(`## Uno\n\n${words("b", 150)}\n\n## Due\n\n${words("b", 150)}\n\n${takeaway("b")}`, context);
    expect(none).toMatchObject({ ok: true, question: false });
  });

  it("fails a part whose two replies put the question before prose", async () => {
    const { db, runner, engine } = setUp();
    read(db, runner, 1, { write: true });
    await settle(db);
    engine.reply(trailing("x"), trailing("y"));
    read(db, runner, 2, { write: true });
    await settle(db);
    expect(part(db, 2).itemId).toBeNull();
    expect(read(db, runner, 2).error).toContain("lesson-part-invalid");
  });

  it("refuses a section rewrite whose two replies leave the question before prose", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const before = read(db, runner, 2).lesson!.markdown;
    const section = `## Passo nuovo secondo\n\n${words("nuovo", 150)}\n\n${check("nuova")}\n\nUna frase dopo la domanda.\n\n${takeaway("nuova")}`;
    engine.reply(section, section);
    await expect(
      rewritePartSection(db, { planId: "p", topicId: "t", position: 2, section: 1, run: engine.run, python: null }),
    ).rejects.toThrow("lesson-part-invalid");
    expect(read(db, runner, 2).lesson!.markdown).toBe(before);
  });
});

describe("two writers of one part's text", () => {
  const sectionReply = (tag: string) =>
    `## Passo ${tag} secondo\n\n${words(tag, 150)}\n\n${check(tag)}\n\n${takeaway(tag)}`;

  it("refuses the second of two overlapping section rewrites, which would undo the first", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const releaseFirst = engine.hold("2:balanced");
    const releaseSecond = engine.hold("2:balanced");
    const rewrite = (section: number) =>
      rewritePartSection(db, { planId: "p", topicId: "t", position: 2, section, run: engine.run, python: null });
    const first = rewrite(1);
    const second = rewrite(0);
    // Part 2's first write, then the two section rewrites.
    await engine.called("2:balanced", 3);
    engine.reply(sectionReply("prima"));
    releaseFirst();
    await expect(first).resolves.toMatchObject({ itemId: part(db, 2).itemId });
    engine.reply(`## Passo seconda primo\n\n${words("seconda", 150)}\n\n${takeaway("seconda")}`);
    releaseSecond();
    await expect(second).rejects.toThrow("lesson-changed");
    const markdown = read(db, runner, 2).lesson!.markdown;
    expect(markdown).toContain("## Passo prima secondo");
    expect(markdown).not.toContain("Passo seconda primo");
  });

  it("does not let Riscrivi questa parte undo a section rewritten while it was written", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    const release = engine.hold("2:balanced");
    read(db, runner, 2, { regenerate: true });
    await engine.called("2:balanced", 2);
    engine.reply(sectionReply("sezione"));
    await rewritePartSection(db, { planId: "p", topicId: "t", position: 2, section: 1, run: engine.run, python: null });
    release();
    await settle(db);
    const after = read(db, runner, 2);
    expect(after.lesson!.markdown).toContain("## Passo sezione secondo");
    expect(after.rewrite).toMatchObject({ state: "failed" });
    expect(after.rewrite?.error).toContain("lesson-changed");
  });
});

describe("the level the text already has", () => {
  it("keeps it for the parts to come when the outline is at another level, with no call", async () => {
    const { db, runner, engine } = setUp();
    await readToPartTwo(db, runner);
    // "Semplice" chosen on part 3, then back on part 2, still "bilanciato", the student picks "bilanciato".
    read(db, runner, 3, { wording: "simple" });
    await settle(db);
    expect(liveOutline(db, "t")!.wording).toBe("simple");
    const calls = engine.calls.length;
    const kept = read(db, runner, 2, { wording: "balanced" });
    expect(kept.rewrite).toBeNull();
    expect(liveOutline(db, "t")!.wording).toBe("balanced");
    expect(shown(db, 2)).toBe("2-balanced-1");
    // Part 3, not done and now at a level the outline no longer has, follows it as the part ahead: back to its text at
    // "bilanciato", written before, with no call either.
    await settle(db);
    expect(engine.calls.slice(calls)).toEqual([]);
    expect(shown(db, 3)).toBe("3-balanced-1");
  });
});
