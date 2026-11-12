import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { saveQuizDraft } from "../study/quizJobs";
import { deleteUnfinished, unfinishedActivities } from "./unfinished";

type Db = ReturnType<typeof openDatabase>;

const NOW = new Date(2026, 10, 12, 18).getTime();

function plan(db: Db) {
  db.prepare(
    "INSERT INTO plans (id, title, status, target, created_at, updated_at) VALUES ('p', 'Analisi 1', 'ready', 0.75, 1, 1)",
  ).run();
  for (const [index, title] of ["Limiti", "Derivate"].entries())
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'p', ?, ?, 1)",
    ).run(`t${index}`, title, index);
}

const questions = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `q${index}`,
    stem: `Domanda ${index}`,
    answer: { kind: "tf", value: true },
  }));

/** An item and an open attempt on it, started at `at`. */
function attempt(
  db: Db,
  id: string,
  options: {
    kind?: string;
    topicId?: string | null;
    body?: object;
    at?: number;
    item?: string;
  } = {},
) {
  const item = options.item ?? `item-${id}`;
  db.prepare(
    "INSERT OR IGNORE INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, 'p', ?, ?, ?, 1)",
  ).run(
    item,
    options.topicId === undefined ? "t0" : options.topicId,
    options.kind ?? "quiz",
    JSON.stringify(options.body ?? { complete: true, questions: questions(8) }),
  );
  db.prepare(
    "INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES (?, 'p', ?, ?)",
  ).run(id, item, options.at ?? NOW - 60_000);
  return item;
}

function job(db: Db, id: string, kind: string, state: string, params: object) {
  db.prepare(
    "INSERT INTO jobs (id, kind, state, params_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, kind, state, JSON.stringify(params), NOW - 30_000, NOW - 30_000);
}

describe("unfinished activities", () => {
  it("lists an opened quiz with no answer yet, and counts the answers once some are given", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "a1");
    expect(unfinishedActivities(db, "p", NOW)).toEqual([
      expect.objectContaining({
        id: "attempt:a1",
        kind: "quiz",
        topicId: "t0",
        topicTitle: "Limiti",
        routeTopicId: "t0",
        attemptId: "a1",
        answered: 0,
        total: 8,
        state: "open",
      }),
    ]);
    saveQuizDraft(
      db,
      "a1",
      { q0: "true", q1: "false", q2: "true", q3: "" },
      3,
      "p",
      NOW,
    );
    expect(unfinishedActivities(db, "p", NOW)[0]).toMatchObject({
      answered: 3,
      total: 8,
    });
  });

  it("leaves out what was handed in or is being graded, and keeps one entry per quiz", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "done");
    db.prepare("UPDATE attempts SET submitted_at = ? WHERE id = 'done'").run(
      NOW,
    );
    attempt(db, "grading");
    job(db, "g", "quiz-grade", "running", { attemptId: "grading" });
    attempt(db, "older", { item: "shared", at: NOW - 120_000 });
    attempt(db, "newer", { item: "shared", at: NOW - 60_000 });
    expect(unfinishedActivities(db, "p", NOW).map((entry) => entry.id)).toEqual(
      ["attempt:newer"],
    );
  });

  it("names each kind: gap drill, diagnostic, redo, past paper and simulation, newest first", () => {
    const db = openDatabase(":memory:");
    plan(db);
    const drill = attempt(db, "drill", { at: NOW - 1000 });
    db.prepare(
      "INSERT INTO gaps (id, plan_id, topic_id, opened_at) VALUES ('gap', 'p', 't0', 1)",
    ).run();
    db.prepare("INSERT INTO gap_items (gap_id, item_id) VALUES ('gap', ?)").run(
      drill,
    );
    attempt(db, "diag", {
      kind: "diagnostic",
      topicId: null,
      at: NOW - 2000,
      body: { questions: [{ ...questions(1)[0], topicId: "t1" }] },
    });
    attempt(db, "redo", {
      topicId: null,
      at: NOW - 3000,
      body: { redo: true, complete: true, questions: questions(4) },
    });
    attempt(db, "past", {
      topicId: null,
      at: NOW - 4000,
      body: { pastPaper: 1, complete: true, questions: questions(3) },
    });
    attempt(db, "sim", {
      kind: "simulation",
      topicId: null,
      at: NOW - 5000,
      body: {
        minutes: 60,
        picks: { q0: "x", q1: " " },
        questions: questions(6),
      },
    });
    const list = unfinishedActivities(db, "p", NOW);
    expect(
      list.map((entry) => [entry.kind, entry.answered, entry.total]),
    ).toEqual([
      ["drill", 0, 8],
      ["diagnostic", 0, 1],
      ["redo", 0, 4],
      ["past", 0, 3],
      ["simulation", 1, 6],
    ]);
    // A quiz across the exam opens under the topic of its first question, or the exam's first topic.
    expect(
      list.find((entry) => entry.kind === "diagnostic")?.routeTopicId,
    ).toBe("t1");
    expect(list.find((entry) => entry.kind === "redo")?.routeTopicId).toBe(
      "t0",
    );
  });

  it("shows a quiz still being written, and one whose writing stopped", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "w", {
      body: { complete: false, config: { count: 8 }, questions: questions(2) },
    });
    job(db, "build", "quiz-build", "running", { attemptId: "w" });
    expect(unfinishedActivities(db, "p", NOW)[0]).toMatchObject({
      state: "writing",
      total: 8,
    });
    db.prepare("UPDATE jobs SET state = 'failed' WHERE id = 'build'").run();
    expect(unfinishedActivities(db, "p", NOW)[0]).toMatchObject({
      state: "stopped",
    });
  });

  it("shows an interrupted build as stopped, since nothing is writing it", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "w", {
      body: { complete: false, config: { count: 8 }, questions: questions(2) },
    });
    job(db, "build", "quiz-build", "interrupted", { attemptId: "w" });
    job(db, "sb", "simulation-build", "interrupted", {
      planId: "p",
      minutes: 60,
      batches: [1, 2],
      next: 1,
      questions: [],
    });
    expect(
      unfinishedActivities(db, "p", NOW).map((entry) => [entry.id, entry.state]),
    ).toEqual(
      expect.arrayContaining([
        ["attempt:w", "stopped"],
        ["build:sb", "stopped"],
      ]),
    );
  });

  it("counts a timed quiz or a simulation whose time ran out as expired until it is handed in", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "timed", {
      at: NOW - 3_600_000,
      body: {
        complete: true,
        config: { timerMinutes: 10 },
        questions: questions(2),
      },
    });
    saveQuizDraft(db, "timed", { q0: "true" }, 0, "p", NOW - 3_000_000);
    attempt(db, "sim", {
      kind: "simulation",
      topicId: null,
      at: NOW - 7_200_000,
      body: { minutes: 60, questions: questions(2) },
    });
    expect(
      unfinishedActivities(db, "p", NOW).map((entry) => entry.state),
    ).toEqual(["expired", "expired"]);
    // Once its grading starts, the simulation is handed in.
    db.prepare(
      "UPDATE items SET body_json = json_set(body_json, '$.gradingStartedAt', 1) WHERE kind = 'simulation'",
    ).run();
    expect(
      unfinishedActivities(db, "p", NOW).map((entry) => entry.kind),
    ).toEqual(["quiz"]);
  });

  it("lists a simulation being prepared or prepared and not started", () => {
    const db = openDatabase(":memory:");
    plan(db);
    job(db, "sb", "simulation-build", "running", {
      planId: "p",
      minutes: 60,
      batches: [1, 2],
      next: 1,
      questions: [],
    });
    expect(unfinishedActivities(db, "p", NOW)).toEqual([
      expect.objectContaining({
        id: "build:sb",
        kind: "simulation",
        state: "writing",
      }),
    ]);
  });
});

describe("deleting an unfinished activity", () => {
  it("drops the answers and keeps a finished topic quiz on the path, to do again", () => {
    const db = openDatabase(":memory:");
    plan(db);
    const item = attempt(db, "a1");
    saveQuizDraft(db, "a1", { q0: "true" }, 0, "p", NOW);
    deleteUnfinished(db, undefined, "p", "attempt:a1", NOW);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM attempt_answers").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare("SELECT id FROM items WHERE id = ?").get(item)).toEqual({
      id: item,
    });
    expect(unfinishedActivities(db, "p", NOW)).toEqual([]);
  });

  it("stops the job of a quiz being written and deletes the quiz with it", () => {
    const db = openDatabase(":memory:");
    plan(db);
    const item = attempt(db, "w", {
      body: { complete: false, config: { count: 8 }, questions: [] },
    });
    job(db, "build", "quiz-build", "running", { attemptId: "w" });
    const cancel = vi.fn();
    deleteUnfinished(db, { cancel }, "p", "attempt:w", NOW);
    expect(cancel).toHaveBeenCalledWith("build");
    expect(
      db.prepare("SELECT id FROM items WHERE id = ?").get(item),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM jobs WHERE id = 'build'").get(),
    ).toBeUndefined();
  });

  it("deletes a redo and a simulation with their own items, and the build a simulation started from", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "redo", {
      topicId: null,
      body: { redo: true, complete: true, questions: questions(2) },
    });
    job(db, "sb", "simulation-build", "succeeded", {
      planId: "p",
      minutes: 60,
      batches: [],
      next: 0,
      questions: [{}],
    });
    attempt(db, "sim", {
      kind: "simulation",
      topicId: null,
      body: { minutes: 60, buildJobId: "sb", questions: questions(2) },
    });
    deleteUnfinished(db, undefined, "p", "attempt:redo", NOW);
    deleteUnfinished(db, undefined, "p", "attempt:sim", NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({
      n: 0,
    });
    expect(unfinishedActivities(db, "p", NOW)).toEqual([]);
  });

  it("stops a simulation being prepared", () => {
    const db = openDatabase(":memory:");
    plan(db);
    job(db, "sb", "simulation-build", "running", {
      planId: "p",
      minutes: 60,
      batches: [1],
      next: 0,
      questions: [],
    });
    const cancel = vi.fn();
    deleteUnfinished(db, { cancel }, "p", "build:sb", NOW);
    expect(cancel).toHaveBeenCalledWith("sb");
    expect(unfinishedActivities(db, "p", NOW)).toEqual([]);
  });

  it("refuses what is not unfinished on this exam", () => {
    const db = openDatabase(":memory:");
    plan(db);
    attempt(db, "done");
    db.prepare("UPDATE attempts SET submitted_at = ? WHERE id = 'done'").run(
      NOW,
    );
    expect(() =>
      deleteUnfinished(db, undefined, "p", "attempt:done", NOW),
    ).toThrow("unfinished-missing");
    expect(() =>
      deleteUnfinished(db, undefined, "p", "build:nothing", NOW),
    ).toThrow("unfinished-missing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toEqual({
      n: 1,
    });
  });
});
