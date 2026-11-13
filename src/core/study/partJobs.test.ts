import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { IpcError } from "../../shared/ipc";
import { createRunner } from "../jobs/runner";
import { liveOutline } from "./parts";
import { PART_JOB, ensureAhead, ensurePart, openPart, registerPartJobs, topicParts } from "./partJobs";

type Db = ReturnType<typeof openDatabase>;

/** A plan with one topic of `count` passages of `size` characters, each starting with its own marker, and an engine. */
function seed(db: Db, count: number, size = 7_000) {
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.exec(`
    INSERT INTO plans (id, title, status, content_language, created_at, updated_at) VALUES ('p', 'Analisi 2', 'ready', 'it', 1, 1);
    INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', 'p', 'Funzioni di più variabili', 0, 1);
    INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'pdf', 'Dispense', 'ready', 1, 1);
  `);
  for (let index = 1; index <= count; index++) {
    db.prepare("INSERT INTO passages (id, source_id, text, created_at) VALUES (?, 's', ?, ?)").run(
      `ps${index}`,
      `MARK-${index} `.padEnd(size, "x"),
      index,
    );
    db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('t', ?)").run(`ps${index}`);
  }
  return db;
}

const words = (part: string, count: number) => Array.from({ length: count }, (_, i) => `parola${part}n${i}`).join(" ");
const check = (part: string) =>
  `\`\`\`pyxis-check\n${JSON.stringify({ question: `Domanda ${part}?`, options: ["uno", "due", "tre"], answer: 1, explanation: "Perché." })}\n\`\`\``;
const takeaway = (part: string) => `\`\`\`pyxis-takeaway\n{"text": "Hai imparato il passo ${part}."}\n\`\`\``;

/** A reply of the shape a teaching part must have. */
function partText(part: string): string {
  return `Riprendiamo.\n\n## Passo ${part} primo\n\n${words(part, 150)}\n\n## Passo ${part} secondo\n\n${words(part, 150)}\n\n${check(part)}\n\n${takeaway(part)}`;
}

function recapText(): string {
  const question = { question: "Quale?", options: ["a", "b", "c"], answer: 0 };
  return `## Riepilogo\n\n- uno\n- due\n- tre\n- quattro\n\n\`\`\`pyxis-recap\n${JSON.stringify({ questions: [question, question, question] })}\n\`\`\`\n\n${takeaway("finale")}`;
}

/** The part a request is for: its number, or "recap". */
function partOf(prompt: string): string {
  return /^Part (\d+) of/m.exec(prompt)?.[1] ?? "recap";
}

/**
 * A recorded engine: the outline call cuts the topic one passage per part, and each part call answers with a sound
 * part. `hold` keeps a part's call waiting until released, `fail` makes it throw.
 */
function engine(passages: number) {
  const calls: Array<{ part: string | null; prompt: string }> = [];
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
  const fails = new Map<string, Error>();
  const run: GenerateInput["run"] = async (input) => {
    if (input.responseSchema) {
      calls.push({ part: null, prompt: input.prompt });
      const reply = {
        lessonParts: Array.from({ length: passages }, (_, i) => ({
          title: `Idea ${i + 1}`,
          about: `Dopo la parte ${i + 1} sai farlo.`,
          passages: [`P${i + 1}`],
        })),
      };
      return { structured: reply, text: JSON.stringify(reply), provider: "claude", model: "test-model", inputTokens: 1 };
    }
    const part = partOf(input.prompt);
    calls.push({ part, prompt: input.prompt });
    await holds.get(part)?.promise;
    input.signal?.throwIfAborted();
    const fail = fails.get(part);
    if (fail) throw fail;
    return { text: part === "recap" ? recapText() : partText(part), provider: "claude", model: "test-model", inputTokens: 1 };
  };
  return {
    calls,
    run,
    hold(part: string) {
      let release = () => {};
      const promise = new Promise<void>((resolve) => (release = resolve));
      holds.set(part, { promise, release });
      return () => {
        holds.delete(part);
        release();
      };
    },
    fail(part: string, error: Error | null) {
      if (error) fails.set(part, error);
      else fails.delete(part);
    },
    parts: () => calls.filter((call) => call.part !== null).map((call) => call.part),
  };
}

/** The part jobs by position, as `position:state`, oldest first. */
function jobs(db: Db): string[] {
  return (
    db
      .prepare(
        `SELECT json_extract(params_json, '$.position') AS position, state FROM jobs WHERE kind = '${PART_JOB}' ORDER BY created_at, rowid`,
      )
      .all() as Array<{ position: number; state: string }>
  ).map((row) => `${row.position}:${row.state}`);
}

/** Waits until no part job is queued or running, or until `until` holds. */
async function settle(db: Db, until?: () => boolean) {
  for (let i = 0; i < 400; i++) {
    const busy = db.prepare(`SELECT 1 FROM jobs WHERE kind = '${PART_JOB}' AND state IN ('queued', 'running')`).get();
    if (until ? until() : !busy) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`not settled: ${jobs(db).join(", ")}`);
}

const written = (db: Db) =>
  (liveOutline(db, "t")?.parts ?? []).filter((part) => part.itemId).map((part) => part.position);
const counts = (db: Db) => ({
  outlines: db.prepare("SELECT COUNT(*) FROM lesson_outlines").pluck().get(),
  items: db.prepare("SELECT COUNT(*) FROM items").pluck().get(),
});

let open: Db[] = [];
let folders: string[] = [];
afterEach(() => {
  for (const db of open) if (db.open) db.close();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  open = [];
  folders = [];
});

function setUp(passages: number, size?: number, path = ":memory:", paused = false) {
  const db = openDatabase(path);
  open.push(db);
  if (path === ":memory:" || !db.prepare("SELECT 1 FROM plans").get()) seed(db, passages, size);
  const recorded = engine(passages);
  const runner = createRunner(db, () => {}, undefined, paused);
  registerPartJobs(db, runner, recorded.run, { python: null });
  return { db, runner, engine: recorded };
}

const at = (position: number) => ({ planId: "p", topicId: "t", position });

describe("the lesson-part job", () => {
  it("plans the topic, then writes the part, and names the part, its exam and topic for Attività", async () => {
    const { db, runner, engine } = setUp(6);
    const opened = openPart(db, runner, { planId: "p", topicId: "t", write: true });
    expect(opened).toMatchObject({ mode: "parts", outline: null, position: 1, state: "planning", lesson: null });
    await settle(db);
    expect(engine.calls.map((call) => call.part)).toEqual([null, "1"]);
    expect(liveOutline(db, "t")!.parts.map((part) => part.title)).toEqual([
      "Idea 1",
      "Idea 2",
      "Idea 3",
      "Idea 4",
      "Idea 5",
      "Idea 6",
      "Ripasso del capitolo",
    ]);
    expect(written(db)).toEqual([1]);
    const [view] = runner.finished();
    expect(view).toMatchObject({
      kind: PART_JOB,
      title: "Parte 1 · Idea 1",
      exam: "Analisi 2",
      topic: "Funzioni di più variabili",
      ref: "t:1",
      state: "succeeded",
    });
    expect(view!.steps.map((step) => step.label)).toEqual(["jobs.lessonOutline", "jobs.lessonPart"]);
  });

  it("keeps the saved outline when the write fails, and a retry writes the part without planning again", async () => {
    const { db, runner, engine } = setUp(6);
    engine.fail("1", new IpcError("cli-failed", "engines.errors.cli-failed", { provider: "claude" }, "exit 1"));
    ensurePart(db, runner, at(1));
    await settle(db);
    expect(jobs(db)).toEqual(["1:failed"]);
    expect(liveOutline(db, "t")!.parts).toHaveLength(7);
    expect(written(db)).toEqual([]);
    const failed = openPart(db, runner, { planId: "p", topicId: "t" });
    expect(failed).toMatchObject({ state: "failed", error: "cli-failed [claude]: exit 1", lesson: null });
    engine.fail("1", null);
    openPart(db, runner, { planId: "p", topicId: "t", position: 1, write: true });
    await settle(db);
    expect(jobs(db)).toEqual(["1:succeeded"]);
    expect(engine.calls.filter((call) => call.part === null)).toHaveLength(1);
    expect(written(db)).toEqual([1]);
  });
});

describe("one part ahead", () => {
  it("opens 1, 2, 5 and 6 and never has more than one job ahead of what the student reads", async () => {
    const { db, runner, engine } = setUp(6);
    openPart(db, runner, { ...at(1), write: true });
    expect(jobs(db)).toEqual(["1:queued"]);
    await settle(db);
    // The page reads the part once its job is done: part 2 starts, and reading part 1 again starts nothing more.
    expect(openPart(db, runner, at(1))).toMatchObject({ state: "written", next: { position: 2, state: "writing" } });
    openPart(db, runner, at(1));
    openPart(db, runner, { ...at(1), write: true });
    expect(jobs(db)).toEqual(["1:succeeded", "2:queued"]);
    const releaseThree = engine.hold("3");
    await settle(db);
    // Opening part 2 starts part 3 and only part 3.
    openPart(db, runner, { ...at(2), write: true });
    expect(jobs(db)).toEqual(["1:succeeded", "2:succeeded", "3:queued"]);
    await settle(db, () => engine.parts().includes("3"));
    // A jump to part 5 writes part 5 alone, never 4 to fill the gap.
    expect(openPart(db, runner, { ...at(5), write: true })).toMatchObject({ state: "writing" });
    expect(jobs(db)).toEqual(["1:succeeded", "2:succeeded", "3:running", "5:queued"]);
    await settle(db, () => written(db).includes(5));
    // Part 5 is written, but part 3 is still being written ahead: reading part 5 starts nothing.
    openPart(db, runner, at(5));
    expect(jobs(db)).toEqual(["1:succeeded", "2:succeeded", "3:running", "5:succeeded"]);
    releaseThree();
    await settle(db);
    openPart(db, runner, at(5));
    expect(jobs(db)).toEqual(["1:succeeded", "2:succeeded", "3:succeeded", "5:succeeded", "6:queued"]);
    // Opening part 6 while its job is queued starts no second job.
    expect(openPart(db, runner, { ...at(6), write: true })).toMatchObject({ state: "writing" });
    expect(jobs(db)).toHaveLength(5);
    await settle(db);
    expect(written(db)).toEqual([1, 2, 3, 5, 6]);
    expect(engine.parts()).toEqual(["1", "2", "3", "5", "6"]);
  });

  it("leaves a failed part ahead for the student, and retries it when the student opens it", async () => {
    const { db, runner, engine } = setUp(6);
    engine.fail("2", new IpcError("quota", "engines.errors.quota", { provider: "claude" }, "limit"));
    ensurePart(db, runner, at(1));
    await settle(db);
    ensureAhead(db, runner, at(1));
    await settle(db);
    expect(jobs(db)).toEqual(["1:succeeded", "2:failed"]);
    openPart(db, runner, at(1));
    ensureAhead(db, runner, at(1));
    expect(jobs(db)).toEqual(["1:succeeded", "2:failed"]);
    expect(topicParts(db, { planId: "p", topicId: "t" }).outline!.parts[1]).toMatchObject({ state: "failed" });
    engine.fail("2", null);
    openPart(db, runner, { ...at(2), write: true });
    expect(jobs(db)).toEqual(["1:succeeded", "2:queued"]);
    await settle(db);
    expect(written(db)).toEqual([1, 2]);
  });

  it("starts nothing after the last part, nor ahead of a topic of one part", async () => {
    const one = setUp(1, 3_000);
    openPart(one.db, one.runner, { ...at(1), write: true });
    await settle(one.db);
    expect(openPart(one.db, one.runner, at(1))).toMatchObject({ state: "written", next: null });
    expect(jobs(one.db)).toEqual(["1:succeeded"]);
    // One part: no planning call and no recap.
    expect(one.engine.calls.map((call) => call.part)).toEqual(["1"]);

    const { db, runner } = setUp(6);
    ensurePart(db, runner, at(1));
    await settle(db);
    ensurePart(db, runner, at(7));
    await settle(db);
    expect(openPart(db, runner, at(7))).toMatchObject({ state: "written", next: null });
    expect(jobs(db)).toEqual(["1:succeeded", "7:succeeded"]);
  });

  it("resumes an interrupted job when its part, or the part before it, is opened", async () => {
    const { db, runner } = setUp(6, undefined, ":memory:", true);
    ensurePart(db, runner, at(1));
    db.prepare(`UPDATE jobs SET state = 'interrupted' WHERE kind = '${PART_JOB}'`).run();
    runner.activate();
    expect(jobs(db)).toEqual(["1:interrupted"]);
    expect(openPart(db, runner, at(1))).toMatchObject({ state: "failed", error: null });
    openPart(db, runner, { ...at(1), write: true });
    expect(jobs(db)).toEqual(["1:queued"]);
    await settle(db);
    // The part ahead was interrupted too: opening part 1 resumes it instead of starting another.
    const params = JSON.stringify({ planId: "p", topicId: "t", position: 2 });
    db.prepare(
      `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES ('j2', '${PART_JOB}', ?, 'interrupted', 0, 1, 1)`,
    ).run(params);
    db.prepare(
      "INSERT INTO job_steps (id, job_id, name, position, label, state) VALUES ('s1', 'j2', 'outline', 0, 'jobs.lessonOutline', 'pending'), ('s2', 'j2', 'write', 1, 'jobs.lessonPart', 'pending')",
    ).run();
    openPart(db, runner, at(1));
    expect(jobs(db)).toEqual(["2:queued", "1:succeeded"]);
    await settle(db);
    expect(written(db)).toEqual([1, 2]);
  });
});

describe("a part that is not finished leaves nothing half-saved", () => {
  async function withPartOne() {
    const setup = setUp(6);
    ensurePart(setup.db, setup.runner, at(1));
    await settle(setup.db);
    return setup;
  }

  it("on a cancel while the part is written", async () => {
    const { db, runner, engine } = await withPartOne();
    const before = counts(db);
    const release = engine.hold("2");
    ensurePart(db, runner, at(2));
    await settle(db, () => engine.parts().includes("2"));
    const [job] = runner.list().filter((view) => view.ref === "t:2");
    runner.cancel(job!.id);
    release();
    await settle(db);
    expect(jobs(db)).toEqual(["1:succeeded", "2:cancelled"]);
    expect(counts(db)).toEqual(before);
    expect(written(db)).toEqual([1]);
    expect(openPart(db, runner, at(2))).toMatchObject({ state: "failed", error: null });
  });

  it("on an engine error", async () => {
    const { db, runner, engine } = await withPartOne();
    const before = counts(db);
    engine.fail("2", new IpcError("not-logged-in", "engines.errors.not-logged-in", { provider: "claude" }, "401"));
    ensurePart(db, runner, at(2));
    await settle(db);
    expect(counts(db)).toEqual(before);
    expect(written(db)).toEqual([1]);
    expect(openPart(db, runner, at(2))).toMatchObject({ state: "failed", error: "not-logged-in [claude]: 401" });
  });

  it("with no AI tool set up: no outline for a new topic, and the part's book text for a planned one", async () => {
    const fresh = setUp(1, 3_000);
    fresh.db.prepare("DELETE FROM feature_engines").run();
    openPart(fresh.db, fresh.runner, { ...at(1), write: true });
    await settle(fresh.db);
    // Even a topic of one part, which is planned without a call, keeps no outline.
    expect(counts(fresh.db)).toEqual({ outlines: 0, items: 0 });
    const book = openPart(fresh.db, fresh.runner, at(1));
    expect(book).toMatchObject({ state: "book", outline: null, lesson: { fallback: true, passageIds: ["ps1"] } });
    expect(fresh.engine.calls).toEqual([]);

    const { db, runner } = await withPartOne();
    const before = counts(db);
    db.prepare("DELETE FROM feature_engines").run();
    openPart(db, runner, { ...at(2), write: true });
    await settle(db);
    expect(counts(db)).toEqual(before);
    const part = openPart(db, runner, at(2));
    expect(part).toMatchObject({
      state: "book",
      lesson: { fallback: true, fallbackReason: "engines.errors.engine-missing", passageIds: ["ps2"] },
    });
    expect(part.mode === "parts" && part.lesson?.markdown).toContain("MARK-2");
    expect(part.mode === "parts" && part.lesson?.markdown).not.toContain("MARK-1");
  });

  it("on a quit while the part is written, and the next start resumes it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "pyxis-parts-"));
    folders.push(folder);
    const path = join(folder, "workspace.db");
    const first = setUp(6, undefined, path);
    ensurePart(first.db, first.runner, at(1));
    await settle(first.db);
    const before = counts(first.db);
    const release = first.engine.hold("2");
    ensurePart(first.db, first.runner, at(2));
    await settle(first.db, () => first.engine.parts().includes("2"));
    first.db.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = setUp(6, undefined, path);
    expect(jobs(second.db)).toEqual(["1:succeeded", "2:interrupted"]);
    expect(counts(second.db)).toEqual(before);
    expect(written(second.db)).toEqual([1]);
    openPart(second.db, second.runner, { ...at(2), write: true });
    await settle(second.db);
    expect(jobs(second.db)).toEqual(["1:succeeded", "2:succeeded"]);
    expect(written(second.db)).toEqual([1, 2]);
  });
});

describe("opening a part", () => {
  it("validates the part and the topic, and sends a finished lesson written before parts to the existing reader", async () => {
    const { db, runner } = setUp(6);
    expect(() => openPart(db, runner, { planId: "p", topicId: "t", position: 3, write: true })).toThrow("part-missing");
    expect(() => openPart(db, runner, { planId: "p", topicId: "other" })).toThrow("topic-missing");
    expect(() => openPart(db, runner, { planId: "p", topicId: "t", itemId: "nothing" })).toThrow("item-missing");
    expect(jobs(db)).toEqual([]);
    // Finished with "Fatto": the lesson step is recorded. An unfinished one is rewritten in parts (oldLessons.test.ts).
    db.exec(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, engine_provider, prompt_template, created_at)
      VALUES ('old', 'p', 't', 'lesson', '{"cacheKey": "k", "markdown": "## Vecchia"}', 'claude', 'lesson.write', 1);
      INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
      VALUES ('done', 'lesson_completed', 'p', 't', '{"activity": "lesson", "itemId": "old"}', 2)`);
    expect(openPart(db, runner, { planId: "p", topicId: "t", write: true })).toEqual({ mode: "legacy", old: "finished" });
    expect(openPart(db, runner, { planId: "p", topicId: "t", itemId: "old" })).toEqual({ mode: "legacy", old: "finished" });
    expect(openPart(db, runner, { planId: "p", topicId: "t" }, { agentLesson: true })).toEqual({ mode: "legacy" });
    expect(jobs(db)).toEqual([]);
  });

  it("opens a part by its item, and the first part not done without a position", async () => {
    const { db, runner } = setUp(6);
    ensurePart(db, runner, at(1));
    await settle(db);
    const itemId = liveOutline(db, "t")!.parts[0]!.itemId!;
    const part = openPart(db, runner, { planId: "p", topicId: "t", itemId });
    expect(part).toMatchObject({
      mode: "parts",
      position: 1,
      state: "written",
      summary: "Hai imparato il passo 1.",
      lesson: { itemId },
    });
    expect(part.mode === "parts" && part.outline).toMatchObject({ teaching: 6, done: 0 });
    db.prepare("UPDATE lesson_parts SET done_at = 5 WHERE position = 1").run();
    expect(openPart(db, runner, { planId: "p", topicId: "t" })).toMatchObject({ position: 2 });
    const parts = topicParts(db, { planId: "p", topicId: "t" });
    expect(parts.outline).toMatchObject({ teaching: 6, done: 1 });
    expect(parts.outline!.minutesLeft).toBe(
      liveOutline(db, "t")!.parts.slice(1).reduce((sum, entry) => sum + entry.minutes, 0),
    );
  });

  it("estimates a topic not planned yet from the planning rules", () => {
    const { db } = setUp(6);
    // 42,000 characters in six passages: six parts of 7,000 characters (8 minutes each) and the recap.
    expect(topicParts(db, { planId: "p", topicId: "t" })).toEqual({ outline: null, estimate: { parts: 6, minutes: 52 } });
    const small = setUp(1, 3_000);
    expect(topicParts(small.db, { planId: "p", topicId: "t" }).estimate).toEqual({ parts: 1, minutes: 5 });
  });
});
