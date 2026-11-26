import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { SCHEMA_VERSION } from "../db/migrate";
import type { GenerateInput } from "../engine/generate";
import { trackCall } from "../jobs/activity";
import { createRunner, type Runner } from "../jobs/runner";
import { currentUsageScope } from "../engine/usage";
import { deleteMapAndBuilds, registerMapJobs } from "../maps/generate";
import { listAllMaps } from "../maps/library";
import { listMaps, renameMap } from "../maps/store";
import { unfinishedActivities } from "../plans/unfinished";
import { readQuiz, registerQuizJobs, saveQuizDraft } from "../study/quizJobs";
import { registerQuizGradingJobs, submitQuiz } from "../study/quizGrading";
import type { MapResultView, QuizResultView } from "../../shared/ipc";
import { setToolRunner } from "./jobs";
import { MAP_TOPIC_MAX, mapInput, mapTool } from "./map";
import { quizInput, quizTool, quizTopic } from "./quiz";
import {
  dropStrayToolResults,
  linkToolResults,
  restoreToolResult,
  restoreToolResults,
  retryToolResult,
  startToolResults,
  takeBackToolResults,
  toolNote,
  toolView,
  undoToolResult,
} from "./results";
import type { ToolTurn } from "./server";

/*
 * The chat's map and quiz tools with the real job runner and the real map and quiz builds; only the model's replies are
 * recorded. A call returns once its job is queued, and the result follows that job.
 */

type Db = ReturnType<typeof openDatabase>;

function fixture() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)", JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  run("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1), ('chem', 'Chimica', 2)");
  run("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 1, 1)");
  run("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('kin', 'mech', 'Cinematica', 0, 1), ('dyn', 'mech', 'Dinamica', 1, 1)");
  run("INSERT INTO sources (id, kind, title, status, subject_id, created_at, updated_at) VALUES ('src', 'pdf', 'Appunti', 'ready', 'phys', 1, 1)");
  run("INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'src', 1, '{}', 1)");
  run(
    `INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES
      ('p1', 'src', 'doc', 'La velocità è lo spostamento nel tempo.', 1),
      ('p2', 'src', 'doc', 'La forza di attrito si oppone al moto relativo delle superfici.', 2),
      ('p3', 'src', 'doc', 'Il secondo principio lega forza, massa e accelerazione.', 3)`,
  );
  run("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('kin', 'p1'), ('dyn', 'p2'), ('dyn', 'p3')");
  run("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat', 'Dinamica', 1, 1)");
  return db;
}

function turn(place: { planId: string | null; subject: string | null }): ToolTurn {
  return {
    chatId: "chat",
    tally: {},
    kept: {},
    place: () => place,
    engine: () => ({ provider: "claude", model: "claude-sonnet-5" }),
    started: () => undefined,
    finished: () => undefined,
  };
}

const reply = (structured: unknown) => ({ structured, text: JSON.stringify(structured), provider: "claude", model: "fixture", inputTokens: 1 });

/** A focused map of the topic: a root, three branches and the passages it was given. */
const mapRun: GenerateInput["run"] = async (input) => {
  const prompt = JSON.parse(input.prompt) as { passages: Array<{ id: string }> };
  const ids = [...new Set(prompt.passages.map((passage) => passage.id))];
  const nodes = [
    { id: "r", label: "Dinamica", parent: null, sources: ids.slice(0, 1) },
    { id: "a", label: "Forze", parent: "r", sources: ids.slice(0, 1) },
    { id: "b", label: "Principi", parent: "r", sources: ids.slice(0, 1) },
    { id: "c", label: "Attrito", parent: "r", sources: ids.slice(0, 1) },
    { id: "d", label: "Statico", parent: "c", sources: ids.slice(0, 1) },
  ];
  return reply({ result: { kind: "map", nodes, edges: [] } });
};

/** Quiz batches: multiple-choice questions, then open ones, on the passages given. */
const quizRun: GenerateInput["run"] = async (input) => {
  const prompt = JSON.parse(input.prompt) as { count: number; questionKinds: string[]; previousQuestions: string[]; passages: Array<{ id: string }> };
  const passageIds = prompt.passages.slice(0, 1).map((passage) => passage.id);
  return reply({
    questions: prompt.questionKinds.map((kind, i) => {
      const stem = `Domanda ${prompt.previousQuestions.length + i + 1} sull'attrito`;
      const common = { stem, explanation: "Perché l'attrito si oppone al moto.", passageIds };
      if (kind === "mcq") return { ...common, kind, options: ["A", "B", "C", "D"], correct: 0 };
      if (kind === "tf") return { ...common, kind, correct: true };
      if (kind === "completion") return { ...common, stem: `${stem}: {{1}}`, kind, accepted: ["attrito"] };
      if (kind === "matching") return { ...common, kind, pairs: [["a", "1"], ["b", "2"], ["c", "3"]] };
      return { ...common, kind, reference: "Si oppone al moto.", rubric: ["Nomina il verso", "Nomina le superfici"] };
    }),
  });
};

let runner: Runner | undefined;
afterEach(() => setToolRunner(undefined));

/** A runner with the map and quiz jobs; `hold` keeps every model call waiting until it is resolved. */
function jobs(db: Db, options: { map?: GenerateInput["run"]; quiz?: GenerateInput["run"] } = {}) {
  runner = createRunner(db, () => undefined);
  registerMapJobs(db, runner, options.map ?? mapRun);
  registerQuizJobs(db, runner, options.quiz ?? quizRun);
  registerQuizGradingJobs(db, runner, async () => reply({ score: 1, explanation: "Giusto." }));
  setToolRunner(runner);
  return runner;
}

/** A model call that waits until `release` is called, so a test can look at the result while its job works. */
function held(run: NonNullable<GenerateInput["run"]>) {
  let release = () => undefined as void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const wrapped: GenerateInput["run"] = async (input) => {
    await Promise.race([gate, new Promise<never>((_, reject) => input.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))))]);
    return run(input);
  };
  return { run: wrapped, release: () => release() };
}

async function until(check: () => boolean, what: () => unknown) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${JSON.stringify(what())}`);
}

const mapOf = (db: Db, id: string) => toolView(db, "chat", id) as MapResultView;
const quizOf = (db: Db, id: string) => toolView(db, "chat", id) as QuizResultView;
const jobOf = (db: Db, id: string) => db.prepare("SELECT state, dismissed FROM jobs WHERE id = ?").get(id) as { state: string; dismissed: number };
const listed = (ids: string[]) => runner!.list().filter((job) => ids.includes(job.id)).map((job) => job.id);
const finishedToday = (ids: string[]) => runner!.finished().filter((job) => ids.includes(job.id)).map((job) => job.id);

async function makeMap(db: Db, place = { planId: null as string | null, subject: "fisica 1" as string | null }) {
  const outcome = await mapTool(db).run(turn(place), mapInput.parse({ topic: "  dinamica\n e attrito " }));
  expect(outcome.declined).toBeUndefined();
  const id = outcome.shown!.resultId;
  const jobId = (JSON.parse(db.prepare("SELECT data_json FROM chat_tool_results WHERE id = ?").pluck().get(id) as string) as { jobId: string }).jobId;
  return { id, jobId, text: outcome.text };
}

async function makeQuiz(db: Db, topic = "Dinamica", place = { planId: "mech" as string | null, subject: null as string | null }, questions?: number) {
  const outcome = await quizTool(db).run(turn(place), quizInput.parse({ topic, ...(questions ? { questions } : {}) }));
  expect(outcome.declined).toBeUndefined();
  return { id: outcome.shown!.resultId, text: outcome.text };
}

describe("create_map", () => {
  it("takes a short topic, one line, and nothing else", () => {
    expect(mapInput.parse({ topic: "  le leggi\n\tdi Newton " }).topic).toBe("le leggi di Newton");
    expect(mapInput.parse({ topic: "x".repeat(MAP_TOPIC_MAX + 30) }).topic).toHaveLength(MAP_TOPIC_MAX);
    expect(mapInput.safeParse({ topic: " a " }).success).toBe(false);
    expect(mapInput.safeParse({ topic: "x".repeat(MAP_TOPIC_MAX * 2 + 1) }).success).toBe(false);
    expect(mapInput.safeParse({ topic: "Dinamica", subjectId: "chem" }).success).toBe(false);
  });

  it("returns once the build is queued, and the result follows the build to the finished map", async () => {
    const db = fixture();
    const gate = held(mapRun!);
    jobs(db, { map: gate.run });
    const { id, jobId, text } = await makeMap(db);
    expect(text).toContain('"Dinamica e attrito" in Mappe, under Fisica 1');
    expect(mapOf(db, id)).toMatchObject({ job: "working", undone: false, gone: false, topic: "Dinamica e attrito", subject: "Fisica 1", concepts: 0 });
    // The build is the map's own, with the topic as its words and its title.
    const params = JSON.parse(db.prepare("SELECT params_json FROM jobs WHERE id = ?").pluck().get(jobId) as string) as Record<string, unknown>;
    expect(params).toMatchObject({ input: { subjectId: "phys" }, instruction: "Dinamica e attrito", title: "Dinamica e attrito" });
    gate.release();
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    expect(mapOf(db, id)).toMatchObject({ job: "done", concepts: 5, branches: 3, shape: [0, 0, 1], topic: "Dinamica e attrito" });
    expect(listMaps(db, { subjectId: "phys" })).toEqual([expect.objectContaining({ title: "Dinamica e attrito", instruction: "Dinamica e attrito" })]);
    expect(toolNote(mapOf(db, id))).toContain("with 5 concepts in 3 branches");
    db.close();
  });

  it("goes under the chat's exam's subject, refuses a chat without one, and makes one map per reply", async () => {
    const db = fixture();
    jobs(db);
    const tool = mapTool(db);
    const inExam = await tool.run(turn({ planId: "mech", subject: null }), mapInput.parse({ topic: "Dinamica" }));
    expect(mapOf(db, inExam.shown!.resultId)).toMatchObject({ subjectId: "phys", subject: "Fisica 1" });
    const nowhere = await tool.run(turn({ planId: null, subject: null }), mapInput.parse({ topic: "Dinamica" }));
    expect(nowhere).toMatchObject({ declined: true });
    expect(nowhere.text).toContain("no subject");
    const one = turn({ planId: null, subject: "Chimica" });
    expect((await tool.run(one, mapInput.parse({ topic: "Legami" }))).declined).toBeUndefined();
    const again = await tool.run(one, mapInput.parse({ topic: "Acidi" }));
    expect(again).toMatchObject({ declined: true });
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results WHERE tool = 'create_map'").pluck().get()).toBe(2);
    db.close();
  });

  it("«Annulla» takes the map out of every list, search and job with the student's edits, and «Ripristina» brings it back whole", async () => {
    const db = fixture();
    jobs(db);
    const { id, jobId } = await makeMap(db);
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    const mapId = mapOf(db, id).mapId;
    renameMap(db, { subjectId: "phys" }, mapId, "La mia dinamica");
    expect(finishedToday([jobId])).toEqual([jobId]);

    // A finished map undone was made: its card says so, not that its creation stopped.
    expect(undoToolResult(db, "chat", id)).toMatchObject({ undone: true, stopped: false, topic: "La mia dinamica" });
    expect(listMaps(db, { subjectId: "phys" })).toEqual([]);
    expect(listAllMaps(db)).toEqual([]);
    expect(listAllMaps(db, "dinamica")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM maps").pluck().get()).toBe(0);
    expect(finishedToday([jobId])).toEqual([]);
    expect(toolNote(mapOf(db, id))).toContain("the student then undid it");
    // A second «Annulla» changes nothing.
    expect(undoToolResult(db, "chat", id)).toMatchObject({ undone: true });

    expect(restoreToolResult(db, "chat", id)).toMatchObject({ undone: false, job: "done", topic: "La mia dinamica", concepts: 5 });
    expect(listMaps(db, { subjectId: "phys" })).toEqual([expect.objectContaining({ id: mapId, title: "La mia dinamica" })]);
    expect(listAllMaps(db, "dinamica")).toHaveLength(1);
    expect(finishedToday([jobId])).toEqual([jobId]);
    db.close();
  });

  it("«Ferma» while the map is built stops the build and takes it out of Attività; «Ripristina» goes on with it", async () => {
    const db = fixture();
    const gate = held(mapRun!);
    jobs(db, { map: gate.run });
    const { id, jobId } = await makeMap(db);
    await until(() => jobOf(db, jobId).state === "running", () => jobOf(db, jobId));
    expect(listed([jobId])).toEqual([jobId]);
    // No map was made: the card says the creation stopped, never that a map left Mappe.
    expect(undoToolResult(db, "chat", id)).toMatchObject({ undone: true, stopped: true });
    await until(() => jobOf(db, jobId).state === "cancelled", () => jobOf(db, jobId));
    expect(listed([jobId])).toEqual([]);
    expect(mapOf(db, id)).toMatchObject({ undone: true, stopped: true });
    gate.release();
    expect(restoreToolResult(db, "chat", id)).toMatchObject({ undone: false, stopped: false, job: "working" });
    expect(jobOf(db, jobId)).toEqual({ state: "queued", dismissed: 0 });
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    expect(listMaps(db, { subjectId: "phys" })).toHaveLength(1);
    db.close();
  });

  it("a failed build shows its error and «Riprova» runs it again; a deleted map shows as gone", async () => {
    const db = fixture();
    let fail = true;
    jobs(db, {
      map: async (input) => {
        if (fail) throw new Error("quota [claude]: usage limit");
        return mapRun!(input);
      },
    });
    const { id } = await makeMap(db);
    await until(() => mapOf(db, id).job === "failed", () => mapOf(db, id));
    expect(mapOf(db, id).error).toMatch(/^quota/);
    fail = false;
    expect(retryToolResult(db, "chat", id)).toMatchObject({ job: "working", error: null });
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    db.prepare("DELETE FROM maps").run();
    expect(mapOf(db, id)).toMatchObject({ job: "done", gone: true, concepts: 0 });
    db.close();
  });

  it("a build a restart cut off goes on when core starts, unless its result was undone or its reply was never saved", async () => {
    const db = fixture();
    const gate = held(mapRun!);
    jobs(db, { map: gate.run });
    const saved = await makeMap(db);
    const undone = await mapTool(db).run(turn({ planId: null, subject: "Chimica" }), mapInput.parse({ topic: "Legami" }));
    const undoneJob = (JSON.parse(db.prepare("SELECT data_json FROM chat_tool_results WHERE id = ?").pluck().get(undone.shown!.resultId) as string) as { jobId: string }).jobId;
    undoToolResult(db, "chat", undone.shown!.resultId);
    // Both replies were saved; a third call's reply never was, since Pyxis closed while it was written.
    db.prepare("INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m1', 'chat', 'assistant', 'x', 1)").run();
    linkToolResults(db, "chat", "m1", [saved.id, undone.shown!.resultId]);
    const lost = await mapTool(db).run(turn({ planId: null, subject: "Fisica 1" }), mapInput.parse({ topic: "Attrito" }));
    const lostJob = (JSON.parse(db.prepare("SELECT data_json FROM chat_tool_results WHERE id = ?").pluck().get(lost.shown!.resultId) as string) as { jobId: string }).jobId;
    db.prepare("UPDATE jobs SET state = 'interrupted'").run();
    // A new runner, as after a restart, that has not picked the jobs up yet.
    const after = createRunner(db, () => undefined, undefined, true);
    setToolRunner(after);
    startToolResults(db);
    expect(jobOf(db, saved.jobId).state).toBe("queued");
    expect(jobOf(db, undoneJob).state).toBe("interrupted");
    // No card can show, open or undo what the lost reply started: its build is given up and its row goes.
    expect(jobOf(db, lostJob)).toEqual({ state: "cancelled", dismissed: 2 });
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results WHERE id = ?").pluck().get(lost.shown!.resultId)).toBe(0);
    db.close();
  });

  it("an answer given again stops a map still being built, and one that fails gives it back, or leaves it undone while the stop settles", async () => {
    const db = fixture();
    const gate = held(mapRun!);
    jobs(db, { map: gate.run });
    const { id, jobId } = await makeMap(db);
    await until(() => jobOf(db, jobId).state === "running", () => jobOf(db, jobId));
    expect(takeBackToolResults(db, "chat", [id])).toEqual([id]);
    // The build has not finished its stop yet: the earlier answer comes back, with the map undone and «Ripristina».
    expect(jobOf(db, jobId).state).toBe("running");
    expect(() => restoreToolResults(db, "chat", [id])).not.toThrow();
    expect(mapOf(db, id).undone).toBe(true);
    await until(() => jobOf(db, jobId).state === "cancelled", () => jobOf(db, jobId));
    gate.release();
    restoreToolResults(db, "chat", [id]);
    expect(mapOf(db, id)).toMatchObject({ undone: false, job: "working" });
    db.close();
  });

  it("an answer given again gives up the wait of a build that failed on a usage limit, so it never writes the map later", async () => {
    const db = fixture();
    let fail = true;
    jobs(db, {
      map: async (input) => {
        if (fail) throw new Error("quota [claude]: usage limit");
        return mapRun!(input);
      },
    });
    const { id, jobId } = await makeMap(db);
    await until(() => mapOf(db, id).job === "failed", () => mapOf(db, id));
    // The student chose to wait for the requests to come back: the build is retried by itself then.
    expect(runner!.hold(jobId, Date.now() + 60)).toBe(true);
    fail = false;
    expect(takeBackToolResults(db, "chat", [id])).toEqual([id]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(jobOf(db, jobId).state).toBe("failed");
    expect(listMaps(db, { subjectId: "phys" })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM settings WHERE key LIKE 'job-wait:%'").pluck().get()).toBe(0);
    db.close();
  });

  it("a map deleted in Mappe while it was built is gone from the card, which offers no resume the runner would refuse", async () => {
    const db = fixture();
    const gate = held(mapRun!);
    jobs(db, { map: gate.run });
    const { id, jobId } = await makeMap(db);
    await until(() => jobOf(db, jobId).state === "running", () => jobOf(db, jobId));
    deleteMapAndBuilds(db, runner!, { subjectId: "phys" }, { jobId });
    await until(() => jobOf(db, jobId).state === "cancelled", () => jobOf(db, jobId));
    expect(mapOf(db, id)).toMatchObject({ gone: true, undone: false });
    expect(() => retryToolResult(db, "chat", id)).toThrow();
    db.close();
  });

  it("says what the build's model call is doing and since when, as the app's other wait states do", async () => {
    const db = fixture();
    const gate = held(mapRun!);
    jobs(db, {
      map: async (input) => {
        // As the engine does for every call of a job (`generate`), which a recorded run skips.
        const call = trackCall(currentUsageScope()?.jobId);
        try {
          return await gate.run!(input);
        } finally {
          call.end();
        }
      },
    });
    const { id, jobId } = await makeMap(db);
    await until(() => jobOf(db, jobId).state === "running" && mapOf(db, id).activity !== null, () => mapOf(db, id));
    expect(mapOf(db, id).activity).toMatchObject({ phase: "starting", since: expect.any(Number) });
    gate.release();
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    expect(mapOf(db, id).activity).toBeNull();
    db.close();
  });

  it("a result no reply shows takes its map and its build with it", async () => {
    const db = fixture();
    jobs(db);
    const { id, jobId } = await makeMap(db);
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    dropStrayToolResults(db, "chat");
    expect(toolView(db, "chat", id)).toBeNull();
    expect(listMaps(db, { subjectId: "phys" })).toEqual([]);
    expect(jobOf(db, jobId).state).toBe("succeeded");
    db.close();
  });
});

describe("create_quiz", () => {
  it("takes a short topic and a number of questions inside the quiz setup's range", () => {
    expect(quizInput.parse({ topic: " attrito " })).toEqual({ topic: "attrito" });
    expect(quizInput.parse({ topic: "attrito", questions: 5 }).questions).toBe(5);
    expect(quizInput.safeParse({ topic: "attrito", questions: 0 }).success).toBe(false);
    expect(quizInput.safeParse({ topic: "attrito", questions: 11 }).success).toBe(false);
    expect(quizInput.safeParse({ topic: "attrito", questions: 2.5 }).success).toBe(false);
    expect(quizInput.safeParse({ topic: "attrito", planId: "other" }).success).toBe(false);
  });

  it("finds the exam's topic the words name, or spans the exam on those words", () => {
    const db = fixture();
    expect(quizTopic(db, "mech", "dinamica")).toEqual({ id: "dyn", title: "Dinamica", exact: true });
    expect(quizTopic(db, "mech", "Esercizi di cinematica")).toEqual({ id: "kin", title: "Cinematica", exact: false });
    expect(quizTopic(db, "mech", "attrito")).toBeNull();
    // Words that name two topics span the exam, so the quiz reads both topics' material and not the first one's only.
    expect(quizTopic(db, "mech", "Cinematica e dinamica")).toBeNull();
    db.close();
  });

  it("matches a topic's title as whole words only, so a longer word that holds it spans the exam instead", () => {
    const db = fixture();
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('fric', 'mech', 'Attrito', 2, 1)").run();
    // "Termodinamica" holds "dinamica" but is not the topic Dinamica: the quiz spans the exam with the word as its focus.
    expect(quizTopic(db, "mech", "Termodinamica")).toBeNull();
    expect(quizTopic(db, "mech", "Attrito statico")).toEqual({ id: "fric", title: "Attrito", exact: false });
    expect(quizTopic(db, "mech", "l'attrito")).toEqual({ id: "fric", title: "Attrito", exact: false });
    db.close();
  });

  it("writes a quiz whose words name two topics across the exam, with the words as its focus", async () => {
    const db = fixture();
    jobs(db);
    await quizTool(db).run(turn({ planId: "mech", subject: null }), quizInput.parse({ topic: "Cinematica e dinamica" }));
    const params = JSON.parse(db.prepare("SELECT params_json FROM jobs WHERE kind = 'quiz-build'").pluck().get() as string) as {
      input: { scope: string; topicId?: string; focus?: string };
    };
    expect(params.input).toMatchObject({ scope: "plan", focus: "Cinematica e dinamica" });
    expect(params.input.topicId).toBeUndefined();
    db.close();
  });

  it("goes in the chat's exam, or the subject's only exam, and refuses a chat whose quiz would have no exam", async () => {
    const db = fixture();
    jobs(db);
    const tool = quizTool(db);
    const bySubject = await tool.run(turn({ planId: null, subject: "Fisica 1" }), quizInput.parse({ topic: "Dinamica" }));
    expect(quizOf(db, bySubject.shown!.resultId)).toMatchObject({ planId: "mech", exam: "Meccanica" });
    const none = await tool.run(turn({ planId: null, subject: "Chimica" }), quizInput.parse({ topic: "Legami" }));
    expect(none).toMatchObject({ declined: true });
    expect(none.text).toContain("a quiz belongs to an exam");
    db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('opt', 'phys', 'Ottica', 'ready', 1, 1)").run();
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('lens', 'opt', 'Lenti', 0, 1)").run();
    const two = await tool.run(turn({ planId: null, subject: "Fisica 1" }), quizInput.parse({ topic: "Dinamica" }));
    expect(two.text).toContain("2 exams (Meccanica, Ottica)");
    db.close();
  });

  it("makes one quiz per reply, on the named topic or across the exam with the words as its focus", async () => {
    const db = fixture();
    jobs(db);
    const tool = quizTool(db);
    const one = turn({ planId: "mech", subject: null });
    const first = await tool.run(one, quizInput.parse({ topic: "attrito", questions: 4 }));
    expect(first.text).toContain('quiz of 4 questions on "Attrito" in the exam Meccanica');
    expect((await tool.run(one, quizInput.parse({ topic: "Dinamica" }))).declined).toBe(true);
    const params = JSON.parse(db.prepare("SELECT params_json FROM jobs WHERE kind = 'quiz-build'").pluck().get() as string) as {
      input: { scope: string; count: number; focus?: string };
      snapshot: { focus?: string; passages: Array<{ id: string }> };
    };
    expect(params.input).toMatchObject({ scope: "plan", count: 4, focus: "attrito" });
    // Across the exam, the passages that name the words come first and alone.
    expect(params.snapshot).toMatchObject({ focus: "attrito", passages: [{ id: "p2" }] });
    db.close();
  });

  it("the result follows the quiz's writing, and counts its questions by kind", async () => {
    const db = fixture();
    const gate = held(quizRun!);
    jobs(db, { quiz: gate.run });
    const { id } = await makeQuiz(db);
    expect(quizOf(db, id)).toMatchObject({ job: "working", topic: "Dinamica", exam: "Meccanica", count: 10, routeTopicId: "dyn", handedIn: false });
    gate.release();
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    const view = quizOf(db, id);
    expect(view.count).toBe(10);
    expect(Object.values(view.kinds).reduce((sum, n) => sum + n, 0)).toBe(10);
    expect(view.minutes).toBeGreaterThan(0);
    expect(unfinishedActivities(db, "mech")).toEqual([expect.objectContaining({ attemptId: view.attemptId, kind: "quiz", total: 10 })]);
    db.close();
  });

  it("«Annulla» takes the quiz out of the exam with the answers given so far, and «Ripristina» brings them back", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeQuiz(db, "Dinamica", undefined, 4);
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    const { attemptId } = quizOf(db, id);
    const questions = readQuiz(db, attemptId).questions;
    saveQuizDraft(db, attemptId, { [questions[0]!.id]: "0", [questions[1]!.id]: "vero" }, 2, "mech");
    const before = readQuiz(db, attemptId);
    const citations = () => db.prepare("SELECT COUNT(*) FROM item_passages").pluck().get();
    expect(citations()).toBeGreaterThan(0);

    expect(undoToolResult(db, "chat", id)).toMatchObject({ undone: true, stopped: false });
    expect(unfinishedActivities(db, "mech")).toEqual([]);
    expect(() => readQuiz(db, attemptId)).toThrow("quiz-missing");
    expect(db.prepare("SELECT COUNT(*) FROM items WHERE kind = 'quiz'").pluck().get()).toBe(0);
    expect(citations()).toBe(0);
    expect(runner!.finished().filter((job) => job.kind === "quiz-build")).toEqual([]);

    expect(restoreToolResult(db, "chat", id)).toMatchObject({ undone: false, job: "done", count: 4 });
    expect(readQuiz(db, attemptId)).toEqual(before);
    expect(unfinishedActivities(db, "mech")).toEqual([expect.objectContaining({ attemptId, answered: 2 })]);
    expect(citations()).toBeGreaterThan(0);
    expect(runner!.finished().filter((job) => job.kind === "quiz-build")).toHaveLength(1);
    db.close();
  });

  it("«Ferma» while the quiz is written stops it, and «Ripristina» writes the rest", async () => {
    const db = fixture();
    let calls = 0;
    const gate = held(quizRun!);
    // The first batch arrives, the second waits.
    jobs(db, { quiz: async (input) => (++calls === 1 ? quizRun!(input) : gate.run!(input)) });
    const { id } = await makeQuiz(db);
    const { attemptId } = quizOf(db, id);
    await until(() => readQuiz(db, attemptId).questions.length > 0, () => readQuiz(db, attemptId));
    // Its writing stopped half way: the card says the creation stopped, not that a quiz left the exam.
    expect(undoToolResult(db, "chat", id)).toMatchObject({ undone: true, stopped: true });
    const build = db.prepare("SELECT id FROM jobs WHERE kind = 'quiz-build'").pluck().get() as string;
    await until(() => jobOf(db, build).state === "cancelled", () => jobOf(db, build));
    expect(quizOf(db, id)).toMatchObject({ undone: true, stopped: true });
    expect(runner!.list().filter((job) => job.id === build)).toEqual([]);
    gate.release();
    expect(restoreToolResult(db, "chat", id)).toMatchObject({ undone: false, job: "working" });
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    expect(readQuiz(db, attemptId).questions).toHaveLength(10);
    db.close();
  });

  it("a passage deleted while the quiz was undone leaves its build, which finishes from the passages left", async () => {
    const db = fixture();
    let calls = 0;
    const gate = held(quizRun!);
    jobs(db, { quiz: async (input) => (++calls === 1 ? quizRun!(input) : gate.run!(input)) });
    const { id } = await makeQuiz(db);
    const { attemptId } = quizOf(db, id);
    await until(() => readQuiz(db, attemptId).questions.length > 0, () => readQuiz(db, attemptId));
    // Its writing stopped half way: the card says the creation stopped, not that a quiz left the exam.
    expect(undoToolResult(db, "chat", id)).toMatchObject({ undone: true, stopped: true });
    const build = db.prepare("SELECT id FROM jobs WHERE kind = 'quiz-build'").pluck().get() as string;
    await until(() => jobOf(db, build).state === "cancelled", () => jobOf(db, build));
    expect(quizOf(db, id)).toMatchObject({ undone: true, stopped: true });
    // The student removes the notes' passage on the second principle while the quiz is out of the exam.
    db.prepare("DELETE FROM topic_passages WHERE passage_id = 'p3'").run();
    db.prepare("DELETE FROM passages WHERE id = 'p3'").run();
    gate.release();
    expect(restoreToolResult(db, "chat", id)).toMatchObject({ undone: false, job: "working" });
    await until(() => ["succeeded", "failed"].includes(jobOf(db, build).state), () => jobOf(db, build));
    expect(jobOf(db, build).state).toBe("succeeded");
    expect(readQuiz(db, attemptId).questions).toHaveLength(10);
    expect(db.prepare("SELECT passage_id FROM item_passages ORDER BY passage_id").pluck().all()).toEqual(["p2"]);
    const params = JSON.parse(db.prepare("SELECT params_json FROM jobs WHERE id = ?").pluck().get(build) as string) as {
      snapshot: { passages: Array<{ id: string }> };
    };
    expect(params.snapshot.passages.map((passage) => passage.id)).toEqual(["p2"]);
    db.close();
  });

  it("a quiz whose every passage was deleted while it was undone cannot be restored, and says so", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeQuiz(db, "Dinamica", undefined, 2);
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    undoToolResult(db, "chat", id);
    db.prepare("DELETE FROM topic_passages WHERE topic_id = 'dyn'").run();
    db.prepare("DELETE FROM passages WHERE id IN ('p2', 'p3')").run();
    expect(quizOf(db, id)).toMatchObject({ undone: true, restorable: false });
    expect(() => restoreToolResult(db, "chat", id)).toThrow("tool-restore-gone");
    expect(db.prepare("SELECT COUNT(*) FROM items").pluck().get()).toBe(0);
    db.close();
  });

  it("a quiz handed in keeps its grade: «Annulla» is refused and an answer given again leaves it", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeQuiz(db, "Dinamica", undefined, 2);
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    const { attemptId } = quizOf(db, id);
    const picks = Object.fromEntries(readQuiz(db, attemptId).questions.map((question) => [question.id, "0"]));
    submitQuiz(db, runner!, attemptId, picks);
    expect(quizOf(db, id).handedIn).toBe(true);
    expect(() => undoToolResult(db, "chat", id)).toThrow("tool-handed-in");
    expect(takeBackToolResults(db, "chat", [id])).toEqual([]);
    dropStrayToolResults(db, "chat");
    expect(db.prepare("SELECT COUNT(*) FROM attempts WHERE id = ?").pluck().get(attemptId)).toBe(1);
    db.close();
  });

  it("restores a quiz undone before a migration added a column, and leaves out a column its record has that the table lost", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeQuiz(db, "Dinamica", undefined, 2);
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    const { attemptId } = quizOf(db, id);
    const before = readQuiz(db, attemptId);
    undoToolResult(db, "chat", id);
    const record = JSON.parse(db.prepare("SELECT undone_json FROM chat_tool_results WHERE id = ?").pluck().get(id) as string) as {
      schema: number;
      rows: { items: Array<Record<string, unknown>> };
    };
    expect(record.schema).toBe(SCHEMA_VERSION);
    // A later version adds a column with a default, and the record names one the table no longer has.
    db.exec("ALTER TABLE items ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0");
    record.rows.items[0]!.dropped_column = "x";
    db.prepare("UPDATE chat_tool_results SET undone_json = ? WHERE id = ?").run(JSON.stringify(record), id);
    expect(restoreToolResult(db, "chat", id)).toMatchObject({ undone: false, count: 2 });
    expect(readQuiz(db, attemptId)).toEqual(before);
    expect(db.prepare("SELECT reviewed FROM items WHERE kind = 'quiz'").pluck().get()).toBe(0);
    db.close();
  });

  it("restores all of a quiz or none of it, and says plainly when its exam is gone", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeQuiz(db, "Dinamica", undefined, 2);
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    undoToolResult(db, "chat", id);
    const saved = db.prepare("SELECT undone_json FROM chat_tool_results WHERE id = ?").pluck().get(id) as string;
    // A row that cannot go back (its attempt names an exam that is not there) undoes the rows put back before it.
    const broken = JSON.parse(saved) as { rows: { attempts: Array<Record<string, unknown>> } };
    broken.rows.attempts[0]!.plan_id = "nowhere";
    db.prepare("UPDATE chat_tool_results SET undone_json = ? WHERE id = ?").run(JSON.stringify(broken), id);
    expect(() => restoreToolResult(db, "chat", id)).toThrow();
    expect(db.prepare("SELECT COUNT(*) FROM items WHERE kind = 'quiz'").pluck().get()).toBe(0);
    expect(quizOf(db, id)).toMatchObject({ undone: true, restorable: true });
    // The exam is deleted while the quiz is undone: nothing can take it back.
    db.prepare("UPDATE chat_tool_results SET undone_json = ? WHERE id = ?").run(saved, id);
    db.prepare("DELETE FROM plans WHERE id = 'mech'").run();
    expect(quizOf(db, id)).toMatchObject({ undone: true, restorable: false });
    expect(() => restoreToolResult(db, "chat", id)).toThrow("tool-restore-gone");
    expect(db.prepare("SELECT COUNT(*) FROM items").pluck().get()).toBe(0);
    db.close();
  });

  it("says plainly when an undone map's subject is gone", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeMap(db);
    await until(() => mapOf(db, id).job === "done", () => mapOf(db, id));
    undoToolResult(db, "chat", id);
    expect(mapOf(db, id).restorable).toBe(true);
    db.prepare("DELETE FROM subjects WHERE id = 'phys'").run();
    expect(mapOf(db, id)).toMatchObject({ undone: true, restorable: false });
    expect(() => restoreToolResult(db, "chat", id)).toThrow("tool-restore-gone");
    db.close();
  });

  it("an answer given again takes the earlier quiz back, and puts it back when the earlier answer stays", async () => {
    const db = fixture();
    jobs(db);
    const { id } = await makeQuiz(db);
    await until(() => quizOf(db, id).job === "done", () => quizOf(db, id));
    expect(takeBackToolResults(db, "chat", [id])).toEqual([id]);
    expect(unfinishedActivities(db, "mech")).toEqual([]);
    restoreToolResult(db, "chat", id);
    expect(unfinishedActivities(db, "mech")).toHaveLength(1);
    db.close();
  });
});
