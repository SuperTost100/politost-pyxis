import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { deleteMap, listMaps, storeMap } from "../maps/store";
import { createPlan } from "../plans/create";
import { readPlannerSettings, savePlannerHours } from "../plans/planner";
import { readSessions, saveSessions } from "../plans/sessions";
import { setPlanArchived } from "../plans/settings";
import { editPlanTopics } from "../plans/topicsEdit";
import type { DeleteProposalView, ExamProposalView, PathProposalView } from "../../shared/ipc";
import { setToolRunner } from "./jobs";
import { decidedSince, decideProposal } from "./proposals";
import { CARDS_PER_DELETION, deleteInput, proposeDeleteTool } from "./proposeDelete";
import { examInput, proposeExamTool } from "./proposeExam";
import { flashcardsInput, flashcardsTool } from "./flashcards";
import { pathInput, proposePathTool } from "./proposePath";
import { quizInput, quizTool } from "./quiz";
import { chatToolList } from "./registry";
import { dropStrayToolResults, linkToolResults, restoreToolResults, takeBackToolResults, toolNote, toolView, undoToolResult } from "./results";
import type { ToolTurn } from "./server";

/*
 * The "ask first" tools: a proposal changes nothing, only the student's decision through `decideProposal` does, on data
 * that is still what the card showed, and no path ever writes a grade, a score, the review history or study time.
 */

type Db = ReturnType<typeof openDatabase>;

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const NEXT_YEAR = new Date().getFullYear() + 1;

function fixture() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)", JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const { planId } = createPlan(db, {
    title: "Fisica 1",
    subject: "Fisica",
    sourceIds: [],
    sessions: [{ date: day(NEXT_YEAR, 1, 22), time: "09:00", place: "Aula 5", label: "Scritto" }],
    draftTopics: ["Cinematica", "Dinamica", "Lavoro ed energia", "Fluidi", "Termodinamica", "Oscillazioni"].map((title) => ({ title })),
  });
  const topics = db.prepare("SELECT id, title FROM topics WHERE plan_id = ? ORDER BY position").all(planId) as Array<{ id: string; title: string }>;
  const topic = (title: string) => topics.find((entry) => entry.title === title)!.id;
  savePlannerHours(db, { hours: 6 });
  // The student's record: a handed-in quiz with its grade, a review of a card, study time and a gap.
  run(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('graded', ?, ?, 'quiz', '{"complete":true,"questions":[{"id":"q1"}]}', 1)`, planId, topic("Dinamica"));
  run(`INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('graded-a', ?, 'graded', 1, 2)`, planId);
  run(`INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('graded-aa', 'graded-a', '{"picks":{},"results":[],"score":0.7}', 2)`);
  run(`INSERT INTO learning_events (id, kind, plan_id, topic_id, item_id, payload_json, created_at) VALUES ('ev-time', 'active_time', ?, ?, NULL, '{"ms":600000}', 3)`, planId, topic("Cinematica"));
  run(`INSERT INTO learning_events (id, kind, plan_id, topic_id, item_id, payload_json, created_at) VALUES ('ev-answer', 'answer_given', ?, ?, 'graded', '{"score":0.7}', 3)`, planId, topic("Dinamica"));
  run(`INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('gap', ?, ?, 4)`, planId, topic("Dinamica"));
  // Flashcards of Cinematica: three Pyxis made (one reviewed) and one the student wrote.
  for (const [id, seed] of [["c1", "a"], ["c2", "b"], ["c3", "c"], ["mine", null]] as const)
    run(`INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES (?, ?, ?, ?, 'r', ?, 1)`, id, planId, topic("Cinematica"), `F ${id}`, seed);
  run(`INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES ('other', ?, ?, 'F', 'R', 'z', 1)`, planId, topic("Dinamica"));
  run(`INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('rev', 'c1', 'good', '{}', 5)`);
  // An unfinished quiz on Termodinamica, with one answer given.
  run(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('open', ?, ?, 'quiz', '{"complete":true,"questions":[{"id":"q1"},{"id":"q2"}]}', 6)`, planId, topic("Termodinamica"));
  run(`INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES ('open-a', ?, 'open', 6)`, planId);
  run(`INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('open-aa', 'open-a', '{"draft":{"picks":{"q1":"A"}}}', 7)`);
  const subjectId = db.prepare("SELECT subject_id FROM plans WHERE id = ?").pluck().get(planId) as string;
  storeMap(db, { subjectId }, {
    id: "map-dyn",
    title: "Dinamica",
    passageIds: [],
    graph: { nodes: [{ id: "r", label: "Dinamica", parent: null, sources: [] }, { id: "a", label: "Forze", parent: "r", sources: [] }], edges: [] },
  } as never);
  // Chimica: a subject with a source in the Library, and no exam yet.
  run("INSERT INTO subjects (id, name, created_at) VALUES ('chem', 'Chimica generale', 1)");
  run("INSERT INTO sources (id, kind, title, status, subject_id, created_at, updated_at) VALUES ('disp', 'pdf', 'Dispense di Chimica', 'ready', 'chem', 1, 1)");
  run("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('chat', 'Fisica', 1, 1), ('other', 'Altro', 1, 1)");
  current = db;
  return { db, planId, topic, subjectId };
}

/** The tables the student's results and history live in, whole, so a test sees that nothing in them changed. */
function record(db: Db) {
  const all = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  return {
    graded: db.prepare("SELECT * FROM attempts WHERE submitted_at IS NOT NULL ORDER BY id").all(),
    gradedAnswers: db.prepare("SELECT aa.* FROM attempt_answers aa JOIN attempts a ON a.id = aa.attempt_id WHERE a.submitted_at IS NOT NULL").all(),
    reviews: all("card_reviews"),
    events: all("learning_events"),
    gaps: all("gaps"),
    gapAnswers: all("gap_answers"),
  };
}

/** The fixture's database, so a turn can put its chat where the turn says it is, as a chat's own turn would find it. */
let current: Db | undefined;

function turn(place: { planId: string | null; subject: string | null }, chatId = "chat"): ToolTurn {
  current
    ?.prepare("UPDATE chats SET scope_json = ?, subject = ? WHERE id = ?")
    .run(JSON.stringify({ planId: place.planId, ids: [], subjectBy: "student" }), place.subject, chatId);
  return { chatId, tally: {}, kept: {}, place: () => place, engine: () => ({ provider: "claude", model: "s" }), started: () => undefined, finished: () => undefined };
}

let messages = 0;
/** Saves the reply that holds the result, as a finished turn does: only then can the student decide. */
function save(db: Db, chatId: string, resultId: string): void {
  messages += 1;
  const id = `m${messages}`;
  db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES (?, ?, 'assistant', ?, ?)`).run(id, chatId, `\`\`\`pyxis-tool\n${resultId}\n\`\`\``, messages);
  linkToolResults(db, chatId, id, [resultId]);
}

afterEach(() => setToolRunner(undefined));

function jobs(db: Db) {
  const runner = createRunner(db, () => undefined);
  // The exam's build is registered but never run: the test reads the job it queued.
  runner.register("plan-build", { jobClass: "local", steps: [] });
  setToolRunner(runner);
  return runner;
}

describe("propose_path_change", () => {
  it("proposes the date, the hours and the topics, and changes nothing until the student applies it", async () => {
    const { db, planId } = fixture();
    const before = record(db);
    const tool = proposePathTool(db);
    const outcome = await tool.run(
      turn({ planId, subject: "Fisica" }),
      pathInput.parse({
        exam_date: `${NEXT_YEAR}-01-15`,
        weekly_hours: 8,
        remove_topics: ["fluidi"],
        move_topics: [{ title: "Oscillazioni", after: "Dinamica" }],
        add_topics: [{ title: "Urti e quantità di moto", after: "Lavoro ed energia" }],
      }),
    );
    expect(outcome.declined).toBeUndefined();
    expect(outcome.text).toMatch(/not decided yet and nothing has changed/);
    const id = outcome.shown!.resultId;
    const view = toolView(db, "chat", id) as PathProposalView;
    expect(view).toMatchObject({ state: "pending", ready: false, exam: "Fisica 1", hours: { from: 6, to: 8 }, changed: 3 });
    expect(view.date).toMatchObject({ from: day(NEXT_YEAR, 1, 22), to: day(NEXT_YEAR, 1, 15), label: "Scritto" });
    expect(view.before).toEqual([
      { title: "Cinematica", removed: false },
      { title: "Dinamica", removed: false },
      { title: "Lavoro ed energia", removed: false },
      { title: "Fluidi", removed: true },
      { title: "Termodinamica", removed: false },
      { title: "Oscillazioni", removed: false },
    ]);
    expect(view.after.map((topic) => [topic.title, topic.added, topic.movedFrom])).toEqual([
      ["Cinematica", false, null],
      ["Dinamica", false, null],
      ["Oscillazioni", false, 6],
      ["Lavoro ed energia", false, null],
      ["Urti e quantità di moto", true, null],
      ["Termodinamica", false, null],
    ]);
    // Nothing changed: the proposal is only a row.
    expect(readSessions(db, planId)[0]!.date).toBe(day(NEXT_YEAR, 1, 22));
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
    expect(db.prepare("SELECT count(*) FROM topics WHERE plan_id = ? AND archived_at IS NULL").pluck().get(planId)).toBe(6);
    // The reply is not saved yet: nothing can decide on it.
    expect(() => decideProposal(db, "chat", id, "apply", view.seen)).toThrow("proposal-not-ready");
    save(db, "chat", id);
    // Another chat cannot answer it, and a confirm without what the card showed does nothing.
    expect(() => decideProposal(db, "other", id, "apply", view.seen)).toThrow("tool-result-missing");
    expect(decideProposal(db, "chat", id, "apply", undefined).state).toBe("pending");
    expect(decideProposal(db, "chat", id, "apply", "something-else").state).toBe("pending");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);

    const applied = decideProposal(db, "chat", id, "apply", view.seen) as PathProposalView;
    expect(applied.state).toBe("applied");
    const session = readSessions(db, planId)[0]!;
    // The session moved and kept its time, place and label.
    expect(session).toMatchObject({ date: day(NEXT_YEAR, 1, 15), time: "09:00", place: "Aula 5", label: "Scritto" });
    expect(readPlannerSettings(db).weeklyHours).toBe(8);
    expect(db.prepare("SELECT title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position").pluck().all(planId)).toEqual([
      "Cinematica",
      "Dinamica",
      "Oscillazioni",
      "Lavoro ed energia",
      "Urti e quantità di moto",
      "Termodinamica",
    ]);
    // Removed means archived: the topic is still there with its history.
    expect(db.prepare("SELECT archived_at IS NOT NULL FROM topics WHERE plan_id = ? AND title = 'Fluidi'").pluck().get(planId)).toBe(1);
    expect(db.prepare("SELECT grounding FROM topics WHERE title = 'Urti e quantità di moto'").pluck().get()).toBe("general");
    // The path's steps follow: opening stages, the topics in the new order, closing stages, then the archived topic.
    const order = db
      .prepare(`SELECT COALESCE(t.title, n.kind) FROM path_nodes n LEFT JOIN topics t ON t.id = n.topic_id WHERE n.plan_id = ? ORDER BY n.position`)
      .pluck()
      .all(planId) as string[];
    // Each topic's steps stay together: a step out of its block would show as one more run here.
    expect(order.filter((title, i) => i === 0 || order[i - 1] !== title)).toEqual([
      "intro",
      "diagnostic",
      "Cinematica",
      "Dinamica",
      "Oscillazioni",
      "Lavoro ed energia",
      "Urti e quantità di moto",
      "Termodinamica",
      "simulation",
      "final",
      "Fluidi",
    ]);
    expect(record(db)).toEqual(before);
    // A second press changes nothing more.
    expect(decideProposal(db, "chat", id, "apply", view.seen).state).toBe("applied");
    expect(toolNote(applied)).toMatch(/the student applied it/);
  });

  it("refuses what it cannot propose, with the path's topics when a title does not match", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const place = { planId, subject: "Fisica" };
    const refused = async (args: unknown) => {
      const out = await tool.run(turn(place), pathInput.parse(args));
      expect(out.declined).toBe(true);
      expect(out.shown).toBeUndefined();
      return out.text;
    };
    expect(await refused({ remove_topics: ["Elettromagnetismo"] })).toMatch(/1\. Cinematica; 2\. Dinamica/);
    expect(await refused({ exam_date: "2020-01-01" })).toMatch(/already past/);
    expect(await refused({ exam_date: `${NEXT_YEAR}-02-30` })).toMatch(/not a valid date/);
    expect(await refused({ weekly_hours: 6 })).toMatch(/already how the path is/);
    expect(await refused({ move_topics: [{ title: "Fluidi" }] })).toMatch(/needs `after`/);
    expect(await refused({ add_topics: [{ title: "dinamica" }] })).toMatch(/already has a topic/);
    expect(
      await refused({ remove_topics: ["Cinematica", "Dinamica", "Lavoro ed energia", "Fluidi", "Termodinamica", "Oscillazioni"] }),
    ).toMatch(/no topics/);
    // The place is the chat's: no argument names an exam, and the schema refuses one.
    expect(pathInput.safeParse({ planId: "x", weekly_hours: 3 }).success).toBe(false);
    expect(pathInput.safeParse({ weekly_hours: 300 }).success).toBe(false);
    const noExam = await tool.run(turn({ planId: null, subject: null }), pathInput.parse({ weekly_hours: 9 }));
    expect(noExam.text).toMatch(/no exam/);
    expect(db.prepare("SELECT count(*) FROM chat_tool_results").pluck().get()).toBe(0);
  });

  it("tells the model what it asked for and is already so", async () => {
    const { db, planId } = fixture();
    const out = await proposePathTool(db).run(
      turn({ planId, subject: null }),
      pathInput.parse({ exam_date: `${NEXT_YEAR}-01-22`, remove_topics: ["Fluidi"] }),
    );
    expect(out.text).toMatch(new RegExp(`Left out because the exam is already on ${NEXT_YEAR}-01-22\\.`));
    expect(toolView(db, "chat", out.shown!.resultId)).toMatchObject({ date: null, changed: 1 });
  });

  it("allows one proposal of the path per answer", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const answer = turn({ planId, subject: null });
    expect((await tool.run(answer, pathInput.parse({ weekly_hours: 9 }))).declined).toBeUndefined();
    expect((await tool.run(answer, pathInput.parse({ weekly_hours: 10 }))).text).toMatch(/already proposed/);
  });

  it("does not apply a proposal whose path changed since, and says so", async () => {
    const { db, planId, topic } = fixture();
    const out = await proposePathTool(db).run(turn({ planId, subject: null }), pathInput.parse({ remove_topics: ["Fluidi"] }));
    const id = out.shown!.resultId;
    save(db, "chat", id);
    const seen = (toolView(db, "chat", id) as PathProposalView).seen;
    // The student moves a topic on the exam page meanwhile.
    editPlanTopics(db, planId, ["Dinamica", "Cinematica", "Lavoro ed energia", "Fluidi", "Termodinamica", "Oscillazioni"].map((title) => ({ id: topic(title) })));
    expect(toolView(db, "chat", id)).toMatchObject({ state: "stale" });
    expect(decideProposal(db, "chat", id, "apply", seen).state).toBe("stale");
    expect(db.prepare("SELECT archived_at FROM topics WHERE id = ?").pluck().get(topic("Fluidi"))).toBeNull();
    // Hours a proposal does not touch do not make it stale.
    const hours = await proposePathTool(db).run(turn({ planId, subject: null }), pathInput.parse({ exam_date: `${NEXT_YEAR}-01-10` }));
    save(db, "chat", hours.shown!.resultId);
    savePlannerHours(db, { hours: 12 });
    expect(toolView(db, "chat", hours.shown!.resultId)).toMatchObject({ state: "pending" });
  });

  it("lets the student say no, then review it again; a later proposal of the same kind replaces a pending one", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const first = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", first);
    expect(decideProposal(db, "chat", first, "decline", undefined).state).toBe("declined");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
    expect(decideProposal(db, "chat", first, "reopen", undefined).state).toBe("pending");
    const second = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 10 }))).shown!.resultId;
    save(db, "chat", second);
    const old = toolView(db, "chat", first) as PathProposalView;
    expect(old.state).toBe("expired");
    expect(decideProposal(db, "chat", first, "apply", old.seen).state).toBe("expired");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
    expect(toolView(db, "chat", second)).toMatchObject({ state: "pending" });
  });
});

describe("propose_exam", () => {
  it("drafts an exam with the subject's Library material and creates it only on the student's yes", async () => {
    const { db } = fixture();
    const runner = jobs(db);
    const before = record(db);
    const out = await proposeExamTool(db).run(
      turn({ planId: null, subject: "Fisica" }),
      examInput.parse({ title: "Chimica generale", exam_date: `${NEXT_YEAR}-02-09` }),
    );
    expect(out.text).toMatch(/1 source of the student's Library on Chimica generale/);
    const id = out.shown!.resultId;
    expect(db.prepare("SELECT count(*) FROM plans").pluck().get()).toBe(1);
    save(db, "chat", id);
    const view = toolView(db, "chat", id) as ExamProposalView;
    expect(view).toMatchObject({ state: "pending", title: "Chimica generale", subject: "Chimica generale", sources: [{ id: "disp", title: "Dispense di Chimica" }] });
    const applied = decideProposal(db, "chat", id, "apply", view.seen) as ExamProposalView;
    expect(applied.state).toBe("applied");
    const plan = db.prepare("SELECT id, title, status FROM plans WHERE title = 'Chimica generale'").get() as { id: string; status: string };
    expect(plan.status).toBe("building");
    const buildJob = db.prepare("SELECT id FROM jobs WHERE kind = 'plan-build' AND json_extract(params_json, '$.planId') = ?").pluck().get(plan.id);
    // The card names the build, so a stopped one can be started again from it.
    expect(applied.created).toMatchObject({ planId: plan.id, jobId: buildJob, job: "working", gone: false });
    expect(db.prepare("SELECT source_id FROM plan_sources WHERE plan_id = ?").pluck().all(plan.id)).toEqual(["disp"]);
    expect(readSessions(db, plan.id).map((session) => session.date)).toEqual([day(NEXT_YEAR, 2, 9)]);
    expect(runner.list().some((job) => job.kind === "plan-build")).toBe(true);
    expect(record(db)).toEqual(before);
    // A second proposal of an exam with that name is refused: it exists now.
    expect((await proposeExamTool(db).run(turn({ planId: null, subject: null }), examInput.parse({ title: "chimica Generale" }))).text).toMatch(/already has an exam/);
  });

  it("offers no creation without material, and goes stale when an exam of that name appears", async () => {
    const { db } = fixture();
    jobs(db);
    const out = await proposeExamTool(db).run(turn({ planId: null, subject: null }), examInput.parse({ title: "Analisi 2" }));
    const id = out.shown!.resultId;
    save(db, "chat", id);
    const view = toolView(db, "chat", id) as ExamProposalView;
    expect(view.sources).toEqual([]);
    expect(() => decideProposal(db, "chat", id, "apply", view.seen)).toThrow("exam-no-material");
    expect(db.prepare("SELECT count(*) FROM plans").pluck().get()).toBe(1);
    createPlan(db, { title: "Analisi 2", sourceIds: [] });
    expect(toolView(db, "chat", id)).toMatchObject({ state: "stale" });
  });
});

describe("propose_delete", () => {
  it("deletes only the flashcards Pyxis made of the topic, keeps their reviews, and brings them back on undo", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const before = record(db);
    const out = await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "cinematica" }));
    const id = out.shown!.resultId;
    save(db, "chat", id);
    const view = toolView(db, "chat", id) as DeleteProposalView;
    expect(view).toMatchObject({ state: "pending", kind: "flashcards", name: "Cinematica", place: "Fisica 1", count: 3, reviewed: 1, handMade: 1, others: 1 });
    expect(db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get()).toBe(0);
    expect(decideProposal(db, "chat", id, "apply", view.seen).state).toBe("applied");
    expect(db.prepare("SELECT id FROM cards WHERE removed = 1 ORDER BY id").pluck().all()).toEqual(["c1", "c2", "c3"]);
    expect(db.prepare("SELECT removed FROM cards WHERE id = 'mine'").pluck().get()).toBe(0);
    expect(record(db)).toEqual(before);
    expect(decideProposal(db, "chat", id, "undo", undefined).state).toBe("restored");
    expect(db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get()).toBe(0);
    expect(record(db)).toEqual(before);
  });

  it("goes stale when a card is reviewed after the proposal", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "Cinematica" }))).shown!.resultId;
    save(db, "chat", id);
    const seen = (toolView(db, "chat", id) as DeleteProposalView).seen;
    db.prepare(`INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('rev2', 'c2', 'good', '{}', 9)`).run();
    expect(decideProposal(db, "chat", id, "apply", seen).state).toBe("stale");
    expect(db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get()).toBe(0);
  });

  it("deletes a map whole and an unfinished quiz with its answers, and undo puts both back", async () => {
    const { db, planId, subjectId } = fixture();
    jobs(db);
    const before = record(db);
    const tool = proposeDeleteTool(db);
    const map = (await tool.run(turn({ planId, subject: null }), deleteInput.parse({ kind: "map", topic: "dinamica" }))).shown!.resultId;
    save(db, "chat", map);
    const mapView = toolView(db, "chat", map) as DeleteProposalView;
    expect(mapView).toMatchObject({ kind: "map", name: "Dinamica", place: "Fisica", count: 2 });
    decideProposal(db, "chat", map, "apply", mapView.seen);
    expect(listMaps(db, { subjectId })).toEqual([]);
    decideProposal(db, "chat", map, "undo", undefined);
    expect(listMaps(db, { subjectId }).map((entry) => entry.title)).toEqual(["Dinamica"]);

    const quiz = (await tool.run(turn({ planId, subject: null }), deleteInput.parse({ kind: "quiz", topic: "Termodinamica" }))).shown!.resultId;
    save(db, "chat", quiz);
    const quizView = toolView(db, "chat", quiz) as DeleteProposalView;
    expect(quizView).toMatchObject({ kind: "quiz", name: "Termodinamica", count: 2, answered: 1 });
    decideProposal(db, "chat", quiz, "apply", quizView.seen);
    expect(db.prepare("SELECT count(*) FROM items WHERE id = 'open'").pluck().get()).toBe(0);
    expect(record(db)).toEqual(before);
    decideProposal(db, "chat", quiz, "undo", undefined);
    // The draft answer comes back as it was given, under its attempt.
    expect(db.prepare("SELECT attempt_id, payload_json FROM attempt_answers WHERE id = 'open-aa'").get()).toEqual({
      attempt_id: "open-a",
      payload_json: '{"draft":{"picks":{"q1":"A"}}}',
    });
    expect(record(db)).toEqual(before);
  });

  it("never proposes a graded quiz, hand-made cards alone, or anything outside the chat's place", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const tool = proposeDeleteTool(db);
    // The handed-in quiz on Dinamica is not among the quizzes that can go.
    expect((await tool.run(turn({ planId, subject: null }), deleteInput.parse({ kind: "quiz", topic: "Dinamica" }))).text).toMatch(/No unfinished quiz/);
    db.prepare("UPDATE cards SET seed_key = NULL WHERE topic_id = (SELECT topic_id FROM cards WHERE id = 'c1')").run();
    expect((await tool.run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "Cinematica" }))).text).toMatch(/written by the student/);
    expect((await tool.run(turn({ planId: null, subject: "Chimica generale" }), deleteInput.parse({ kind: "map", topic: "Dinamica" }))).text).toMatch(/no concept maps/);
    expect((await tool.run(turn({ planId: null, subject: null }), deleteInput.parse({ kind: "quiz" }))).text).toMatch(/no exam/);
    // An exam, a source or a chat cannot even be asked for.
    expect(deleteInput.safeParse({ kind: "exam" }).success).toBe(false);
    expect(deleteInput.safeParse({ kind: "flashcards", topic: "x", planId }).success).toBe(false);
    expect(db.prepare("SELECT count(*) FROM chat_tool_results").pluck().get()).toBe(0);
  });
});

/** A day `days` from today, at local noon, as sessions store it, and as YYYY-MM-DD. */
const fromToday = (days: number) => {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() + days);
  const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return { at: at.getTime(), key };
};
const DAY = 86_400_000;

describe("a proposal whose data moved on is never applied, and its card can always be cleared", () => {
  it("reads a map proposal whose map was deleted as stale, and lets the student decline it", async () => {
    const { db, planId, subjectId } = fixture();
    jobs(db);
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "map", topic: "Dinamica" }))).shown!.resultId;
    save(db, "chat", id);
    const seen = (toolView(db, "chat", id) as DeleteProposalView).seen;
    deleteMap(db, { subjectId }, "map-dyn");
    expect(toolView(db, "chat", id)).toMatchObject({ state: "stale" });
    expect(decideProposal(db, "chat", id, "apply", seen).state).toBe("stale");
    expect(decideProposal(db, "chat", id, "decline", undefined).state).toBe("declined");
  });

  it("does not move a session that is no longer the next one when the student confirms", async () => {
    const { db, planId } = fixture();
    const soon = fromToday(1);
    const later = fromToday(30);
    saveSessions(db, planId, [{ date: soon.at, label: "Scritto" }, { date: later.at, label: "Orale" }]);
    const id = (await proposePathTool(db).run(turn({ planId, subject: null }), pathInput.parse({ exam_date: fromToday(10).key }))).shown!.resultId;
    save(db, "chat", id);
    const view = toolView(db, "chat", id) as PathProposalView;
    expect(view.date).toMatchObject({ from: soon.at, label: "Scritto" });
    // Two days later the written part is over: the next session is the oral one.
    expect(decideProposal(db, "chat", id, "apply", view.seen, Date.now() + 2 * DAY).state).toBe("stale");
    expect(readSessions(db, planId).map((session) => session.date)).toEqual([soon.at, later.at]);
  });

  it("does not write a date that became past before the click, for a path or a new exam", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const tomorrow = fromToday(1);
    const path = (await proposePathTool(db).run(turn({ planId, subject: null }), pathInput.parse({ exam_date: tomorrow.key }))).shown!.resultId;
    // The exam is proposed in another chat, so this one keeps the exam the path proposal resolves in.
    const exam = (await proposeExamTool(db).run(turn({ planId: null, subject: null }, "other"), examInput.parse({ title: "Chimica generale", exam_date: tomorrow.key }))).shown!.resultId;
    save(db, "chat", path);
    save(db, "other", exam);
    // Both are pending at the time they were made: only the clock makes them stale below.
    expect(toolView(db, "chat", path)).toMatchObject({ state: "pending" });
    expect(toolView(db, "other", exam)).toMatchObject({ state: "pending" });
    const later = Date.now() + 3 * DAY;
    expect(decideProposal(db, "chat", path, "apply", (toolView(db, "chat", path) as PathProposalView).seen, later).state).toBe("stale");
    expect(decideProposal(db, "other", exam, "apply", (toolView(db, "other", exam) as ExamProposalView).seen, later).state).toBe("stale");
    expect(readSessions(db, planId).map((session) => session.date)).toEqual([day(NEXT_YEAR, 1, 22)]);
    expect(db.prepare("SELECT count(*) FROM plans WHERE title = 'Chimica generale'").pluck().get()).toBe(0);
  });

  it("goes stale for flashcards whose topic was archived or whose text changed, and for a quiz whose draft answers changed", async () => {
    const { db, planId, topic } = fixture();
    jobs(db);
    const tool = proposeDeleteTool(db);
    const propose = async (args: unknown) => {
      const id = (await tool.run(turn({ planId, subject: null }), deleteInput.parse(args))).shown!.resultId;
      save(db, "chat", id);
      return id;
    };
    const archived = await propose({ kind: "flashcards", topic: "Cinematica" });
    db.prepare("UPDATE topics SET archived_at = 9 WHERE id = ?").run(topic("Cinematica"));
    expect(toolView(db, "chat", archived)).toMatchObject({ state: "stale" });
    db.prepare("UPDATE topics SET archived_at = NULL WHERE id = ?").run(topic("Cinematica"));
    const edited = await propose({ kind: "flashcards", topic: "Cinematica" });
    db.prepare("UPDATE cards SET front = 'Altro testo' WHERE id = 'c2'").run();
    expect(toolView(db, "chat", edited)).toMatchObject({ state: "stale" });
    const quiz = await propose({ kind: "quiz", topic: "Termodinamica" });
    const seen = (toolView(db, "chat", quiz) as DeleteProposalView).seen;
    db.prepare(`UPDATE attempt_answers SET payload_json = '{"draft":{"picks":{"q1":"B"}}}' WHERE id = 'open-aa'`).run();
    expect(decideProposal(db, "chat", quiz, "apply", seen).state).toBe("stale");
    expect(db.prepare("SELECT count(*) FROM items WHERE id = 'open'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get()).toBe(0);
  });
});

describe("what a proposal is about is found without guessing", () => {
  it("refuses a map title two maps share, and sends the student to Mappe", async () => {
    const { db, planId, subjectId } = fixture();
    jobs(db);
    storeMap(db, { subjectId }, { id: "map-dyn-2", title: "Dinamica", passageIds: [], graph: { nodes: [{ id: "r", label: "Dinamica", parent: null, sources: [] }], edges: [] } } as never);
    const out = await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "map", topic: "Dinamica" }));
    expect(out.declined).toBe(true);
    expect(out.text).toMatch(/2 maps of Fisica are called "Dinamica".*Mappe/);
  });

  it("takes the quiz whose topic is the words exactly over one that only holds them", async () => {
    const { db, planId } = fixture();
    jobs(db);
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('gas', ?, 'Termodinamica dei gas', 9, 1)").run(planId);
    db.prepare(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('gas-quiz', ?, 'gas', 'quiz', '{"complete":true,"questions":[{"id":"q1"}]}', 8)`).run(planId);
    db.prepare("INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES ('gas-a', ?, 'gas-quiz', 8)").run(planId);
    const out = await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "quiz", topic: "Termodinamica" }));
    expect(out.declined).toBeUndefined();
    expect(toolView(db, "chat", out.shown!.resultId)).toMatchObject({ name: "Termodinamica", count: 2 });
  });

  it("refuses a chat whose own exam is archived instead of taking the subject's other exam", async () => {
    const { db, planId } = fixture();
    createPlan(db, { title: "Fisica 2", subject: "Fisica", sourceIds: [], draftTopics: [{ title: "Ottica" }] });
    setPlanArchived(db, planId, true);
    const out = await proposePathTool(db).run(turn({ planId, subject: "Fisica" }), pathInput.parse({ weekly_hours: 9 }));
    expect(out.declined).toBe(true);
    expect(out.text).toMatch(/archived/);
    expect(db.prepare("SELECT count(*) FROM chat_tool_results").pluck().get()).toBe(0);
  });

  it("moves a topic after one the same call adds", async () => {
    const { db, planId } = fixture();
    const out = await proposePathTool(db).run(
      turn({ planId, subject: null }),
      pathInput.parse({ add_topics: [{ title: "Urti", after: "Lavoro ed energia" }], move_topics: [{ title: "Cinematica", after: "Urti" }] }),
    );
    expect(out.declined).toBeUndefined();
    expect((toolView(db, "chat", out.shown!.resultId) as PathProposalView).after.map((entry) => entry.title)).toEqual([
      "Dinamica",
      "Lavoro ed energia",
      "Urti",
      "Cinematica",
      "Fluidi",
      "Termodinamica",
      "Oscillazioni",
    ]);
  });
});

describe("what the security read asked for", () => {
  it("brings back on «Annulla» only the cards this deletion removed and nobody restored or removed again", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "Cinematica" }))).shown!.resultId;
    save(db, "chat", id);
    decideProposal(db, "chat", id, "apply", (toolView(db, "chat", id) as DeleteProposalView).seen);
    // The student restores c2 from Removed in Flashcard, then removes it there again.
    db.prepare("UPDATE cards SET removed = 0 WHERE id = 'c2'").run();
    db.prepare("UPDATE cards SET removed = 1 WHERE id = 'c2'").run();
    const back = decideProposal(db, "chat", id, "undo", undefined) as DeleteProposalView;
    expect(back).toMatchObject({ state: "restored", back: 2 });
    expect(db.prepare("SELECT id FROM cards WHERE removed = 1").pluck().all()).toEqual(["c2"]);
  });

  it("does not put a map back over a map that holds its id again, and says it can no longer", async () => {
    const { db, planId, subjectId } = fixture();
    jobs(db);
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "map", topic: "Dinamica" }))).shown!.resultId;
    save(db, "chat", id);
    decideProposal(db, "chat", id, "apply", (toolView(db, "chat", id) as DeleteProposalView).seen);
    storeMap(db, { subjectId }, { id: "map-dyn", title: "Nuova", passageIds: [], graph: { nodes: [{ id: "r", label: "Nuova", parent: null, sources: [] }], edges: [] } } as never);
    expect(toolView(db, "chat", id)).toMatchObject({ state: "applied", restorable: false });
    expect(decideProposal(db, "chat", id, "undo", undefined).state).toBe("applied");
    expect(listMaps(db, { subjectId }).map((map) => map.title)).toEqual(["Nuova"]);
  });

  it("says a quiz deleted mid-build can no longer come back once its build was given up", async () => {
    const { db, planId } = fixture();
    const runner = jobs(db);
    runner.register("quiz-build", { jobClass: "local", steps: [] });
    const job = runner.start("quiz-build", { attemptId: "open-a" });
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "quiz", topic: "Termodinamica" }))).shown!.resultId;
    save(db, "chat", id);
    decideProposal(db, "chat", id, "apply", (toolView(db, "chat", id) as DeleteProposalView).seen);
    runner.discard(job);
    expect(toolView(db, "chat", id)).toMatchObject({ state: "applied", restorable: false });
    expect(decideProposal(db, "chat", id, "undo", undefined).state).toBe("applied");
  });

  it("keeps an expired proposal expired when the reply that replaced it goes", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const a = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", a);
    const seen = (toolView(db, "chat", a) as PathProposalView).seen;
    // A later turn proposes again, but fails before its reply is saved: the first card is untouched.
    const failed = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 10 }))).shown!.resultId;
    expect(toolView(db, "chat", a)).toMatchObject({ state: "pending" });
    dropStrayToolResults(db, "chat");
    expect(toolView(db, "chat", failed)).toBeNull();
    const b = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 11 }))).shown!.resultId;
    save(db, "chat", b);
    expect(toolView(db, "chat", a)).toMatchObject({ state: "expired" });
    // B's reply is answered again with no proposal: B goes, and A stays expired.
    db.prepare("DELETE FROM messages WHERE body LIKE ?").run(`%${b}%`);
    dropStrayToolResults(db, "chat");
    expect(toolView(db, "chat", a)).toMatchObject({ state: "expired" });
    expect(decideProposal(db, "chat", a, "apply", seen).state).toBe("expired");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
  });

  it("limits the cards made in the chat to the chat's exam or subject now, and goes stale when the chat moves", async () => {
    const { db, planId } = fixture();
    jobs(db);
    db.prepare(`INSERT INTO cards (id, subject_id, front, back, seed_key, created_at) VALUES ('chem-card', 'chem', 'Atomo?', 'Sì', 'x', 1)`).run();
    db.prepare(
      `INSERT INTO chat_tool_results (id, chat_id, message_id, tool, data_json, created_at) VALUES ('made', 'chat', NULL, 'create_flashcards', ?, 1)`,
    ).run(JSON.stringify({ cardIds: ["c1", "chem-card"], duplicates: 0, title: null, deck: "x", fronts: [] }));
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", made_in_chat: true }))).shown!.resultId;
    save(db, "chat", id);
    expect(toolView(db, "chat", id)).toMatchObject({ state: "pending", count: 1, place: "Fisica 1" });
    // The student moves the chat to Chimica generale: the card no longer says what would go.
    db.prepare("UPDATE chats SET scope_json = ?, subject = 'Chimica generale' WHERE id = 'chat'").run(JSON.stringify({ planId: null, ids: [] }));
    expect(toolView(db, "chat", id)).toMatchObject({ state: "stale" });
  });

  it("refuses more cards than one deletion may take, and strips the controls that reorder a name on screen", async () => {
    const { db, planId, topic } = fixture();
    jobs(db);
    const insert = db.prepare("INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES (?, ?, ?, 'f', 'b', ?, 1)");
    for (let i = 0; i <= CARDS_PER_DELETION; i++) insert.run(`many${i}`, planId, topic("Oscillazioni"), `m${i}`);
    expect((await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "Oscillazioni" }))).text).toMatch(
      /more than the 200/,
    );
    db.prepare("UPDATE topics SET title = ? WHERE id = ?").run("Ciner‮amatica", topic("Cinematica"));
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "Ciner‮amatica" }))).shown!.resultId;
    expect((toolView(db, "chat", id) as DeleteProposalView).name).toBe("Cineramatica");
  });
});

describe("propose_delete, a subject's flashcards with no exam", () => {
  it("finds by the subject's name the cards a chat of that subject made, and deletes only those, with an undo for them", async () => {
    const { db, planId, subjectId } = fixture();
    jobs(db);
    // A chat of the subject Fisica (no exam chosen) makes two cards: they belong to the subject and to no exam.
    const made = await flashcardsTool(db).run(
      turn({ planId: null, subject: "Fisica" }),
      flashcardsInput.parse({ cards: [{ front: "Cos'è una forza?", back: "Un'interazione." }, { front: "Unità della forza?", back: "Il newton." }] }),
    );
    const ids = db.prepare("SELECT id FROM cards WHERE plan_id IS NULL AND subject_id = ? ORDER BY id").pluck().all(subjectId) as string[];
    expect(made.shown).toBeDefined();
    expect(ids).toHaveLength(2);
    // One the student wrote with no exam stays, as do the exam's cards.
    db.prepare("INSERT INTO cards (id, subject_id, front, back, seed_key, created_at) VALUES ('mine-subject', ?, 'Mia', 'Mia', NULL, 1)").run(subjectId);
    const examCards = db.prepare("SELECT count(*) FROM cards WHERE plan_id = ? AND removed = 0").pluck().get(planId) as number;

    const out = await proposeDeleteTool(db).run(turn({ planId: null, subject: "Fisica" }), deleteInput.parse({ kind: "flashcards", topic: "fisica" }));
    expect(out.declined).toBeUndefined();
    const id = out.shown!.resultId;
    save(db, "chat", id);
    const view = toolView(db, "chat", id) as DeleteProposalView;
    expect(view).toMatchObject({ state: "pending", kind: "flashcards", name: "Fisica", place: "Fisica", count: 2, handMade: 1, others: examCards });
    expect(decideProposal(db, "chat", id, "apply", view.seen).state).toBe("applied");
    expect(db.prepare("SELECT id FROM cards WHERE removed = 1 ORDER BY id").pluck().all()).toEqual(ids);
    expect(db.prepare("SELECT count(*) FROM cards WHERE plan_id = ? AND removed = 0").pluck().get(planId)).toBe(examCards);
    expect(decideProposal(db, "chat", id, "undo", undefined).state).toBe("restored");
    expect(db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get()).toBe(0);
  });

  it("is resolved again at the click, refuses more than one deletion may take, and finds them from an exam's chat too", async () => {
    const { db, planId, subjectId } = fixture();
    jobs(db);
    const insert = db.prepare("INSERT INTO cards (id, subject_id, front, back, seed_key, created_at) VALUES (?, ?, ?, 'b', ?, 1)");
    insert.run("s1", subjectId, "Uno", "s1");
    insert.run("s2", subjectId, "Due", "s2");
    // From the chat of the subject's exam, by the subject's name.
    const id = (await proposeDeleteTool(db).run(turn({ planId, subject: "Fisica" }), deleteInput.parse({ kind: "flashcards", topic: "Fisica" }))).shown!.resultId;
    save(db, "chat", id);
    const view = toolView(db, "chat", id) as DeleteProposalView;
    expect(view.count).toBe(2);
    // A card made since changes what the deletion would take: the click deletes nothing.
    insert.run("s3", subjectId, "Tre", "s3");
    expect(decideProposal(db, "chat", id, "apply", view.seen).state).toBe("stale");
    expect(db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get()).toBe(0);
    for (let i = 0; i < CARDS_PER_DELETION; i++) insert.run(`many${i}`, subjectId, `m${i}`, `m${i}`);
    expect((await proposeDeleteTool(db).run(turn({ planId: null, subject: "Fisica" }), deleteInput.parse({ kind: "flashcards", topic: "Fisica" }))).text).toMatch(
      /more than the 200/,
    );
  });

  it("says plainly when the subject has no card Pyxis made outside its exams", async () => {
    const { db } = fixture();
    jobs(db);
    const out = await proposeDeleteTool(db).run(turn({ planId: null, subject: "Fisica" }), deleteInput.parse({ kind: "flashcards", topic: "Fisica" }));
    expect(out.declined).toBe(true);
    expect(out.text).toMatch(/Fisica has no flashcards Pyxis made outside its exams/);
  });
});

describe("which proposal is later", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A clock that stands still, and random bytes set by the test: ids made now share their millisecond and sort by `fill`. */
  function oneMillisecond() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 26, 12));
    const random = { fill: 0xff };
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((bytes) => {
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(random.fill);
      return bytes;
    });
    return random;
  }

  it("goes by the order they were made, never by the random part of ids made in the same millisecond", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    // Both proposals in one millisecond, and the later one with the smaller id: the random bytes of a uuidv7 decide
    // the order of ids within a millisecond.
    const random = oneMillisecond();
    const a = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    random.fill = 0x00;
    const b = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 10 }))).shown!.resultId;
    expect(b < a).toBe(true);
    save(db, "chat", a);
    decideProposal(db, "chat", a, "decline", undefined);
    save(db, "chat", b);
    // The later proposal replaced the earlier one: reopened, the earlier one has lapsed, and the later one waits.
    expect(decideProposal(db, "chat", a, "reopen", undefined).state).toBe("expired");
    expect((toolView(db, "chat", b) as PathProposalView).state).toBe("pending");
  });

  it("lets a later pending proposal of the same millisecond expire only the earlier one", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const random = oneMillisecond();
    const a = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", a);
    random.fill = 0x00;
    const b = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 10 }))).shown!.resultId;
    save(db, "chat", b);
    expect((toolView(db, "chat", a) as PathProposalView).state).toBe("expired");
    expect((toolView(db, "chat", b) as PathProposalView).state).toBe("pending");
  });
});

describe("the second review", () => {
  it("never makes a declined proposal pending again once a later one of its kind was saved", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const a = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", a);
    decideProposal(db, "chat", a, "decline", undefined);
    const b = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 10 }))).shown!.resultId;
    save(db, "chat", b);
    expect(decideProposal(db, "chat", a, "reopen", undefined).state).toBe("expired");
    expect(decideProposal(db, "chat", a, "apply", (toolView(db, "chat", a) as PathProposalView).seen).state).toBe("expired");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
  });

  it("matches a topic by its whole name, refuses a name over the limit, and refuses a title two topics share", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const long = "Cinematica ".repeat(11).trim();
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('short', ?, ?, 20, 1), ('longer', ?, ?, 21, 1)").run(
      planId,
      long.slice(0, 120).trim(),
      planId,
      `${long} e dinamica`,
    );
    db.prepare("INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES ('l1', ?, 'longer', 'f', 'b', 'l1', 1), ('s1', ?, 'short', 'f', 'b', 's1', 1)").run(planId, planId);
    const tool = proposeDeleteTool(db);
    const out = await tool.run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: `${long} e dinamica` }));
    expect((toolView(db, "chat", out.shown!.resultId) as DeleteProposalView).name).toBe(`${long} e dinamica`);
    expect(deleteInput.safeParse({ kind: "flashcards", topic: "x".repeat(161) }).success).toBe(false);
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('intro1', ?, 'Introduzione', 30, 1), ('intro2', ?, 'Introduzione', 31, 1)").run(planId, planId);
    db.prepare("INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES ('i1', ?, 'intro1', 'f', 'b', 'i1', 1)").run(planId);
    const twin = await tool.run(turn({ planId, subject: null }), deleteInput.parse({ kind: "flashcards", topic: "Introduzione" }));
    expect(twin.declined).toBe(true);
    expect(twin.text).toMatch(/2 topics of Fisica 1 are called "Introduzione"/);
  });

  it("checks for an existing exam with the name it would save", async () => {
    const { db } = fixture();
    jobs(db);
    const out = await proposeExamTool(db).run(turn({ planId: null, subject: null }), examInput.parse({ title: "Fisica‎ 1" }));
    expect(out.declined).toBe(true);
    expect(out.text).toMatch(/already has an exam/);
  });

  it("refuses the same topic added twice, and a placement the final order contradicts", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const twice = await tool.run(turn({ planId, subject: null }), pathInput.parse({ add_topics: [{ title: "Urti" }, { title: "urti" }] }));
    expect(twice.text).toMatch(/"urti" twice/);
    const crossed = await tool.run(
      turn({ planId, subject: null }),
      pathInput.parse({ move_topics: [{ title: "Cinematica", after: "Dinamica" }, { title: "Dinamica", after: "Lavoro ed energia" }] }),
    );
    expect(crossed.declined).toBe(true);
    expect(crossed.text).toMatch(/"Cinematica" no longer comes after "Dinamica"/);
    // A move after a topic that stays where it is still works.
    const fine = await tool.run(turn({ planId, subject: null }), pathInput.parse({ move_topics: [{ title: "Cinematica", after: "Dinamica" }] }));
    expect(fine.declined).toBeUndefined();
  });

  it("gives a quiz no exam that is still being built", async () => {
    const { db, planId } = fixture();
    jobs(db);
    db.prepare("UPDATE plans SET status = 'building' WHERE id = ?").run(planId);
    const out = await quizTool(db).run(turn({ planId, subject: null }), quizInput.parse({ topic: "Dinamica" }));
    expect(out.declined).toBe(true);
    expect(out.text).toMatch(/still being built/);
  });

  it("brings back the proposal a stopped regenerate withdrew, even when the stopped reply saved one of its kind", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const a = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", a);
    expect(takeBackToolResults(db, "chat", [a])).toEqual([a]);
    // The new answer is stopped after saving a proposal of the same kind; its reply is then discarded.
    const b = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 10 }))).shown!.resultId;
    save(db, "chat", b);
    db.prepare("DELETE FROM messages WHERE body LIKE ?").run(`%${b}%`);
    restoreToolResults(db, "chat", [a]);
    dropStrayToolResults(db, "chat");
    expect(toolView(db, "chat", a)).toMatchObject({ state: "pending" });
  });
});

describe("proposals and the rest of the chat", () => {
  it("offers no tool that decides, and none of the old undo calls act on a proposal", async () => {
    const { db, planId } = fixture();
    jobs(db);
    const names = chatToolList(db, true).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["propose_path_change", "propose_exam", "propose_delete"]));
    expect(names.some((name) => /decide|confirm|apply/.test(name))).toBe(false);
    const id = (await proposePathTool(db).run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", id);
    expect(() => undoToolResult(db, "chat", id)).toThrow("tool-result-missing");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
  });

  it("withdraws a pending proposal while its reply is answered again, and keeps one the student decided on", async () => {
    const { db, planId } = fixture();
    const tool = proposePathTool(db);
    const pending = (await tool.run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", pending);
    const seen = (toolView(db, "chat", pending) as PathProposalView).seen;
    expect(takeBackToolResults(db, "chat", [pending])).toEqual([pending]);
    expect(decideProposal(db, "chat", pending, "apply", seen).state).toBe("expired");
    expect(readPlannerSettings(db).weeklyHours).toBe(6);
    // The new answer failed: the earlier reply and its proposal are back.
    restoreToolResults(db, "chat", [pending]);
    expect(toolView(db, "chat", pending)).toMatchObject({ state: "pending" });
    decideProposal(db, "chat", pending, "apply", seen);
    expect(takeBackToolResults(db, "chat", [pending])).toEqual([]);
    expect(toolView(db, "chat", pending)).toMatchObject({ state: "applied" });
    // A proposal no reply shows goes with its row; what the student applied stays.
    db.prepare("DELETE FROM messages").run();
    dropStrayToolResults(db, "chat");
    expect(db.prepare("SELECT count(*) FROM chat_tool_results").pluck().get()).toBe(0);
    expect(readPlannerSettings(db).weeklyHours).toBe(9);
  });

  it("lists the decisions made since the model's last reply, for the next turn", async () => {
    const { db, planId } = fixture();
    const id = (await proposePathTool(db).run(turn({ planId, subject: null }), pathInput.parse({ weekly_hours: 9 }))).shown!.resultId;
    save(db, "chat", id);
    expect(decidedSince(db, "chat", 0)).toEqual([]);
    decideProposal(db, "chat", id, "decline", undefined, 1000);
    expect(decidedSince(db, "chat", 999)).toEqual([id]);
    expect(decidedSince(db, "chat", 1000)).toEqual([]);
    expect(toolNote(toolView(db, "chat", id)!)).toMatch(/chose not to apply it, so nothing changed/);
  });
});
