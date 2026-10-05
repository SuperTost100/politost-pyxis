import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { saveProfile } from "../profile/profile";
import { importSmartbook } from "../sources/smartbook";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { promptProvenance, templateVersion } from "../engine/prompts";
import { studyHandlers } from "./handlers";
import {
  enqueueSimulation,
  listSimulations,
  openSimulation,
  readSimulation,
  readSimulationBuild,
  recordTopicScores,
  registerSimulationJobs,
  saveSimulationDraft,
  startSimulation,
  submitSimulation,
} from "./simulation";
const engine = (db: ReturnType<typeof openDatabase>) =>
  db
    .prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    )
    .run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
const count = (db: ReturnType<typeof openDatabase>, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
/** A notes/PDF-style plan: topics with passages but no smartbook exercises. */
function notesFixture() {
  const db = openDatabase(":memory:");
  engine(db);
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Appunti', 'ready', 1, 1)",
  ).run();
  for (const t of [0, 1]) {
    db.prepare(
      "INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'plan', ?, ?, 1)",
    ).run(`t${t}`, `Argomento ${t}`, t);
    for (const p of [0, 1]) {
      db.prepare(
        "INSERT INTO passages (id, text, created_at) VALUES (?, ?, 1)",
      ).run(`p${t}${p}`, `Testo ${t}${p}`);
      db.prepare(
        "INSERT INTO topic_passages (topic_id, passage_id) VALUES (?, ?)",
      ).run(`t${t}`, `p${t}${p}`);
    }
  }
  return { db, planId: "plan" };
}
let written = 0;
const writer: GenerateInput["run"] = async (input) => {
  if (!input.system?.includes("written-exam questions")) return response();
  systems.push(input.system);
  const asked = JSON.parse(input.prompt) as {
    count: number;
    passages: Array<{ id: string }>;
  };
  const structured = {
    questions: Array.from({ length: asked.count }, () => ({
      stem: `Domanda scritta ${written++}`,
      reference: "Risposta di riferimento",
      passageIds: [asked.passages[0]!.id],
    })),
  };
  return {
    text: JSON.stringify(structured),
    structured,
    provider: "claude",
    model: "writer-model",
    inputTokens: 1,
  };
};
/** Waits for the question build to be ready, then starts the exam the way the Start button does. */
async function built(db: ReturnType<typeof openDatabase>, planId: string) {
  await buildState(db, planId, "succeeded");
  startSimulation(db, planId);
  return openSimulation(db, planId)!;
}
async function buildState(
  db: ReturnType<typeof openDatabase>,
  planId: string,
  state: string,
) {
  for (let i = 0; i < 400; i++) {
    const build = readSimulationBuild(db, planId);
    if (build?.state === state) return build;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(JSON.stringify(readSimulationBuild(db, planId)));
}
function fixture() {
  const db = openDatabase(":memory:");
  engine(db);
  const imported = importSmartbook(
    db,
    zipSync(
      Object.fromEntries(
        Object.entries({
          "smartbook.json": JSON.stringify({
            id: "sim",
            title: "Fisica",
            access: "public",
            chapters: [
              { id: "c1", number: 1, title: "Moti", file: "01.md" },
              { id: "c2", number: 2, title: "Forze", file: "02.md" },
            ],
          }),
          "chapters/01.md": "## p1 | Velocità\nLa velocità.\n",
          "chapters/02.md": "## p1 | Forza\nLa forza.\n",
          "esercizi.md":
            ':::exercise{id="p1" chapter="1"}\nPratica\n:::solution\npratica\n:::\n:::\n',
          "esami.md":
            ':::exercise{id="x1" chapter="1"}\nQuanto vale la velocità?\n:::solution\n10 m/s\n:::\n:::\n\n:::exercise{id="x2" chapter="2"}\nQuanto vale la forza?\n:::solution\n10 N\n:::\n:::\n',
        }).map(([name, text]) => [name, strToU8(text)]),
      ),
    ),
  );
  const { planId } = createPlan(db, {
    title: "Fisica",
    sourceIds: [imported.sourceId],
  });
  return { db, planId };
}
function response(score = 0.75) {
  const structured = {
    score,
    feedback: "Ragionamento corretto, unità incomplete.",
    missed: ["Unità di misura"],
  };
  return {
    text: JSON.stringify(structured),
    structured,
    provider: "claude",
    model: "actual-grading-model",
    inputTokens: 1,
  };
}
const systems: string[] = [];
const run: GenerateInput["run"] = async (input) => {
  systems.push(input.system ?? "");
  return response();
};
async function until(
  db: ReturnType<typeof openDatabase>,
  attemptId: string,
  state: string,
) {
  for (let i = 0; i < 200; i++) {
    const view = readSimulation(db, attemptId);
    if (view.grading?.state === state) return view;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(JSON.stringify(readSimulation(db, attemptId)));
}
describe("M11 model-graded simulations", () => {
  it("uses exam material, preserves the deadline and freezes saved answers at expiry", async () => {
    const { db, planId } = fixture();
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, run);
    const started = Date.now();
    const opened = startSimulation(db, planId, 30, started, "exam");
    expect(opened.questions.map((q) => q.stem)).toEqual([
      "Quanto vale la velocità?",
      "Quanto vale la forza?",
    ]);
    expect(JSON.stringify(opened)).not.toContain("10 m/s");
    expect(readSimulation(db, opened.attemptId, started + 60000).leftMs).toBe(
      29 * 60000,
    );
    saveSimulationDraft(db, opened.attemptId, {
      [opened.questions[0]!.id]: "dieci metri al secondo",
    });
    const expired = readSimulation(db, opened.attemptId, started + 31 * 60000);
    expect(expired.locked).toBe(true);
    expect(expired.submitted).toBe(false);
    expect(expired.results).toBeUndefined();
    saveSimulationDraft(db, opened.attemptId, {
      [opened.questions[0]!.id]: "late",
    });
    const done = await until(db, opened.attemptId, "succeeded");
    expect(done.picks[opened.questions[0]!.id]).toBe("dieci metri al secondo");
    expect(done.results![0]).toMatchObject({
      score: 0.75,
      provider: "claude",
      model: "actual-grading-model",
      missed: ["Unità di misura"],
    });
    expect(done.results![1]).toMatchObject({
      score: 0,
      provider: "",
      model: "",
      feedback: "Nessuna risposta.",
    });
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain(
      "Write all feedback and missed points in Italian.",
    );
    expect(systems[0]).not.toMatch(/\{\{[A-Za-z]/);
    expect(done.results![0]!.prompt).toEqual(
      promptProvenance("simulation.grade"),
    );
    expect(
      db
        .prepare(
          "SELECT prompt_template, prompt_version FROM items WHERE kind='simulation'",
        )
        .get(),
    ).toEqual({
      prompt_template: "simulation.grade",
      prompt_version: templateVersion("simulation.grade"),
    });
    expect(done.topics.map((t) => t.score)).toEqual([0.75, 0]);
    expect(done.score).toBe(0.375);
    expect(done.leftMs).toBe(0);
    expect(done.submitted).toBe(true);
    db.close();
  });
  it("submits once under concurrent delivery and keeps actual engine provenance", async () => {
    const { db, planId } = fixture();
    let calls = 0;
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, async () => {
      calls++;
      return response();
    });
    const opened = startSimulation(db, planId, 120, Date.now(), "exam");
    const picks = Object.fromEntries(
      opened.questions.map((q) => [q.id, "equivalent answer"]),
    );
    const first = submitSimulation(db, opened.attemptId, picks);
    const second = submitSimulation(db, opened.attemptId, {
      [opened.questions[0]!.id]: "replace",
    });
    expect(second.grading!.jobId).toBe(first.grading!.jobId);
    const done = await until(db, opened.attemptId, "succeeded");
    expect(calls).toBe(2);
    expect(done.picks).toEqual(picks);
    submitSimulation(db, opened.attemptId, {});
    expect(
      db
        .prepare("SELECT count(*) AS n FROM attempt_answers WHERE attempt_id=?")
        .get(opened.attemptId),
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM learning_events WHERE kind='answer_given'",
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(listSimulations(db, planId)[0]).toMatchObject({ score: 0.75 });
    db.close();
  });
  it("restarts a failed grading build without reopening answers or regrading a checkpoint", async () => {
    const { db, planId } = fixture();
    let calls = 0;
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, async () => {
      calls++;
      if (calls === 2) throw new Error("offline");
      return response();
    });
    const opened = startSimulation(db, planId, 30, Date.now(), "exam");
    const frozen = submitSimulation(
      db,
      opened.attemptId,
      Object.fromEntries(opened.questions.map((q) => [q.id, "answer"])),
    );
    await until(db, opened.attemptId, "failed");
    expect(openSimulation(db, planId)!.locked).toBe(true);
    saveSimulationDraft(db, opened.attemptId, {
      [opened.questions[0]!.id]: "cheat",
    });
    expect(
      readSimulation(db, opened.attemptId).picks[opened.questions[0]!.id],
    ).toBe("answer");
    const restarted = createRunner(db, () => {});
    registerSimulationJobs(db, restarted, async () => {
      calls++;
      return response();
    });
    submitSimulation(db, opened.attemptId);
    const done = await until(db, opened.attemptId, "succeeded");
    expect(calls).toBe(3);
    expect(done.grading!.jobId).toBe(frozen.grading!.jobId);
    expect(done.results).toHaveLength(2);
    db.close();
  });
  it("pins configured grading selection and rejects generic local quiz submission", async () => {
    const { db, planId } = fixture();
    db.prepare(
      "INSERT INTO feature_engines (feature,selection_json,updated_at) VALUES('grading',?,1)",
    ).run(JSON.stringify({ provider: "claude", model: "chosen" }));
    const seen: string[] = [];
    const runner = createRunner(db, () => {});
    studyHandlers(db, runner, run, async (input) => {
      seen.push(input.selection.model);
      return response();
    });
    const opened = startSimulation(db, planId, 30, Date.now(), "exam");
    expect(() =>
      studyHandlers(db).quizSubmit({ attemptId: opened.attemptId, picks: {} }),
    ).toThrow("use-simulation-submit");
    submitSimulation(
      db,
      opened.attemptId,
      Object.fromEntries(opened.questions.map((q) => [q.id, "answer"])),
    );
    db.prepare(
      "UPDATE feature_engines SET selection_json=? WHERE feature='grading'",
    ).run(JSON.stringify({ provider: "claude", model: "changed" }));
    await until(db, opened.attemptId, "succeeded");
    expect(seen).toEqual(["chosen", "chosen"]);
    db.close();
  });
  it("does not publish a late model reply after cancellation, and resumes locked grading", async () => {
    const { db, planId } = fixture();
    let release!: () => void;
    let started = false;
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, async () => {
      started = true;
      await new Promise<void>((r) => {
        release = r;
      });
      return response();
    });
    const opened = startSimulation(db, planId, 30, Date.now(), "exam");
    const view = submitSimulation(db, opened.attemptId, {
      [opened.questions[0]!.id]: "answer",
    });
    while (!started) await new Promise((r) => setTimeout(r, 1));
    runner.cancel(view.grading!.jobId);
    release();
    await until(db, opened.attemptId, "cancelled");
    await new Promise((r) => setTimeout(r, 10));
    expect(readSimulation(db, opened.attemptId).submitted).toBe(false);
    expect(
      db.prepare("SELECT count(*) AS n FROM attempt_answers").get(),
    ).toEqual({ n: 0 });
    registerSimulationJobs(db, runner, run);
    submitSimulation(db, opened.attemptId);
    await until(db, opened.attemptId, "succeeded");
    db.close();
  });
  it("needs a grading engine before any attempt or job is written", () => {
    const { db, planId } = fixture();
    db.prepare("DELETE FROM feature_engines").run();
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, run);
    expect(() => startSimulation(db, planId, 30, Date.now(), "exam")).toThrow(
      "engine-missing",
    );
    expect(() => enqueueSimulation(db, planId)).toThrow("engine-missing");
    const notes = notesFixture();
    notes.db.prepare("DELETE FROM feature_engines").run();
    registerSimulationJobs(
      notes.db,
      createRunner(notes.db, () => {}),
      writer,
    );
    expect(() => enqueueSimulation(notes.db, notes.planId)).toThrow(
      "engine-missing",
    );
    for (const [d, table] of [
      [db, "items"],
      [db, "attempts"],
      [db, "jobs"],
      [notes.db, "items"],
      [notes.db, "attempts"],
      [notes.db, "jobs"],
    ] as const)
      expect(count(d, table)).toBe(0);
    db.close();
    notes.db.close();
  });
  it("unlocks the tutor once answers are frozen and keeps an expired exam readable without an engine", async () => {
    const { db, planId } = fixture();
    const runner = createRunner(db, () => {});
    const study = studyHandlers(db, runner, run, run);
    const started = Date.now();
    const opened = startSimulation(db, planId, 30, started, "exam");
    expect(study.activeSimulation()).toMatchObject({
      attemptId: opened.attemptId,
    });
    db.prepare("DELETE FROM feature_engines").run();
    const late = started + 31 * 60000;
    const view = readSimulation(db, opened.attemptId, late);
    expect(view).toMatchObject({
      locked: true,
      submitted: false,
      blocked: "engine-missing",
    });
    expect(view.grading).toBeUndefined();
    expect(() => submitSimulation(db, opened.attemptId, {}, late)).toThrow(
      "engine-missing",
    );
    expect(study.activeSimulation()).not.toBeNull();
    engine(db);
    expect(readSimulation(db, opened.attemptId, late).grading).toBeDefined();
    expect(study.activeSimulation()).toBeNull();
    await until(db, opened.attemptId, "succeeded");
    db.close();
  });
  it("unlocks the tutor while grading failed, so the attempt does not hold Ask", async () => {
    const { db, planId } = fixture();
    const runner = createRunner(db, () => {});
    const study = studyHandlers(db, runner, run, async () => {
      throw new Error("offline");
    });
    const opened = startSimulation(db, planId, 30, Date.now(), "exam");
    submitSimulation(db, opened.attemptId, {
      [opened.questions[0]!.id]: "answer",
    });
    await until(db, opened.attemptId, "failed");
    expect(study.activeSimulation()).toBeNull();
    expect(openSimulation(db, planId)!.grading!.state).toBe("failed");
    db.close();
  });
  it("builds non-smartbook questions in a job, then starts the attempt with truthful provenance", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, writer);
    expect(() => startSimulation(db, planId, 30, Date.now(), "exam")).toThrow(
      "simulation-needs-build",
    );
    saveProfile(db, { interests: ["ciclismo"], interestsOn: true });
    const queued = enqueueSimulation(db, planId, 60) as { jobId: string };
    expect(enqueueSimulation(db, planId, 60)).toEqual(queued);
    expect(count(db, "attempts")).toBe(0);
    expect(readSimulationBuild(db, planId)).toMatchObject({
      jobId: queued.jobId,
    });
    const view = await built(db, planId);
    expect(view.questions).toHaveLength(20);
    expect(new Set(view.questions.map((q) => q.stem)).size).toBe(20);
    expect(view.generated).toEqual({
      provider: "claude",
      model: "writer-model",
    });
    expect(view.leftMs).toBeGreaterThan(59 * 60000);
    expect(readSimulationBuild(db, planId)).toBeNull();
    expect(systems.at(-1)).toContain("Write all output in Italian.");
    expect(systems.at(-1)).toContain("Cite only the supplied passages");
    expect(systems.at(-1)).not.toMatch(/\{\{[A-Za-z>]/);
    expect(systems.at(-1)).toContain("prefer contexts from: ciclismo");
    const item = db
      .prepare(
        "SELECT grounding, engine_provider, model_id, prompt_template, prompt_version FROM items WHERE kind='simulation'",
      )
      .get();
    expect(item).toEqual({
      grounding: "sources",
      engine_provider: "claude",
      model_id: "writer-model",
      prompt_template: "simulation.questions",
      prompt_version: templateVersion("simulation.questions"),
    });
    expect(count(db, "item_passages")).toBeGreaterThan(0);
    submitSimulation(
      db,
      view.attemptId,
      Object.fromEntries(view.questions.map((q) => [q.id, "risposta"])),
    );
    const done = await until(db, view.attemptId, "succeeded");
    expect(done.generated?.model).toBe("writer-model");
    expect(done.results![0]!.model).toBe("actual-grading-model");
    expect(
      (
        db
          .prepare(
            "SELECT prompt_template AS t FROM items WHERE kind='simulation'",
          )
          .get() as { t: string }
      ).t,
    ).toBe("simulation.questions");
    db.close();
  });
  it("repairs an invalid batch without retaining schema validation state", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    let calls = 0;
    registerSimulationJobs(db, runner, async (input) => {
      calls++;
      const result = await writer!({
        ...input,
        prompt: input.prompt.split(
          "\n\nThe previous answer failed validation.",
        )[0]!,
      });
      if (calls === 1) {
        const data = result.structured as {
          questions: Array<{ passageIds: string[] }>;
        };
        data.questions[0]!.passageIds = ["unknown-passage"];
        result.text = JSON.stringify(data);
      }
      return result;
    });
    enqueueSimulation(db, planId);
    expect((await built(db, planId)).questions).toHaveLength(20);
    expect(calls).toBe(3);
    db.close();
  });
  it("keeps a finished build ready, with no clock and no tutor lock, until the student starts it", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, writer);
    const study = studyHandlers(db, runner, run, writer);
    const { jobId } = enqueueSimulation(db, planId, 30) as { jobId: string };
    const ready = await buildState(db, planId, "succeeded");
    expect(ready).toMatchObject({ jobId, minutes: 30, progress: 1 });
    // Long past the would-be deadline: nothing started, nothing expired, nothing graded.
    expect(openSimulation(db, planId, Date.now() + 5 * 3600_000)).toBeNull();
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "learning_events")).toBe(0);
    expect(study.activeSimulation()).toBeNull();
    // Asking again, or reopening the app, finds the same prepared exam instead of rebuilding.
    expect(enqueueSimulation(db, planId, 60)).toEqual({ jobId });
    const reopened = createRunner(db, () => {});
    registerSimulationJobs(db, reopened, writer);
    expect(readSimulationBuild(db, planId)).toMatchObject({
      jobId,
      state: "succeeded",
    });
    // Start is explicit: the clock begins now and the tutor locks only from here.
    const at = Date.now() + 3600_000;
    const started = startSimulation(db, planId, 30, at);
    expect(started.deadline).toBe(at + 30 * 60_000);
    expect(started.questions).toHaveLength(20);
    expect(study.activeSimulation()).toMatchObject({
      attemptId: started.attemptId,
    });
    expect(readSimulationBuild(db, planId)).toBeNull();
    // One build starts one exam.
    expect(() => startSimulation(db, planId)).toThrow("simulation-needs-build");
    expect(count(db, "attempts")).toBe(1);
    db.close();
  });
  it("starts the prepared exam even when exercises were added after it was built", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, writer);
    const { jobId } = enqueueSimulation(db, planId) as { jobId: string };
    await buildState(db, planId, "succeeded");
    db.prepare(
      `INSERT INTO exercises (id, prompt, answer, locator_json, created_at)
       VALUES ('late', 'Esercizio nuovo', 'risposta', ?, 2)`,
    ).run(JSON.stringify({ kind: "generated", topicId: "t0" }));
    expect(readSimulationBuild(db, planId)).toMatchObject({
      jobId,
      state: "succeeded",
    });
    const started = startSimulation(db, planId);
    expect(started.questions).toHaveLength(20);
    expect(started.questions.every((q) => q.stem.startsWith("Domanda scritta"))).toBe(true);
    expect(readSimulationBuild(db, planId)).toBeNull();
    // With the build consumed, the next start uses the new exercise.
    const next = startSimulation(db, planId);
    expect(next.questions.map((q) => q.stem)).toEqual(["Esercizio nuovo"]);
    db.close();
  });
  it("starts a prepared exam with the length asked for now, and a new request updates the prepared length", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    registerSimulationJobs(db, runner, writer);
    const { jobId } = enqueueSimulation(db, planId, 30) as { jobId: string };
    await buildState(db, planId, "succeeded");
    // A later prepare with another length reuses the questions and shows the length the student chose last.
    expect(enqueueSimulation(db, planId, 90)).toEqual({ jobId });
    expect(readSimulationBuild(db, planId)).toMatchObject({ jobId, minutes: 90 });
    // Start with a length uses it; start with none keeps the prepared one.
    const at = Date.now();
    expect(startSimulation(db, planId, 120, at).deadline).toBe(at + 120 * 60_000);
    await (async () => {
      const again = enqueueSimulation(db, planId, 60) as { jobId: string };
      expect(again.jobId).not.toBe(jobId);
      await buildState(db, planId, "succeeded");
    })();
    expect(startSimulation(db, planId, undefined, at).deadline).toBe(at + 60 * 60_000);
    db.close();
  });
  it("does not start a prepared exam whose topics or cited passages changed, and offers a fresh build", async () => {
    for (const change of [
      (db: ReturnType<typeof openDatabase>) => db.prepare("UPDATE topics SET archived_at = 5 WHERE id = 't0'").run(),
      // A re-extract: the topic now holds new passage rows, so the cited ones are gone from it.
      (db: ReturnType<typeof openDatabase>) => {
        db.prepare("DELETE FROM topic_passages WHERE topic_id = 't1'").run();
        db.prepare("INSERT INTO passages (id, text, created_at) VALUES ('fresh', 'Nuovo', 2)").run();
        db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('t1', 'fresh')").run();
      },
    ]) {
      const { db, planId } = notesFixture();
      const runner = createRunner(db, () => {});
      registerSimulationJobs(db, runner, writer);
      const { jobId } = enqueueSimulation(db, planId, 30) as { jobId: string };
      await buildState(db, planId, "succeeded");
      change(db);
      // Nothing to start: the prepared exam is not offered, and Start refuses with the existing "build first" error.
      expect(readSimulationBuild(db, planId)).toBeNull();
      expect(() => startSimulation(db, planId)).toThrow("simulation-needs-build");
      expect(count(db, "attempts")).toBe(0);
      // Preparing again writes new questions from what the plan holds now.
      const next = enqueueSimulation(db, planId, 30) as { jobId: string };
      expect(next.jobId).not.toBe(jobId);
      await buildState(db, planId, "succeeded");
      const view = startSimulation(db, planId);
      expect(view.questions).toHaveLength(20);
      db.close();
    }
  });
  it("retries a failed question build from its checkpoint and writes no attempt until it succeeds", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    let calls = 0;
    registerSimulationJobs(db, runner, async (input) => {
      calls++;
      if (calls === 2) throw new Error("offline");
      return writer(input);
    });
    const { jobId } = enqueueSimulation(db, planId) as { jobId: string };
    const failed = await buildState(db, planId, "failed");
    expect(failed.progress).toBe(0.5);
    expect(count(db, "attempts")).toBe(0);
    runner.retry(jobId);
    await buildState(db, planId, "succeeded");
    expect(calls).toBe(3);
    expect(count(db, "attempts")).toBe(0);
    const view = await built(db, planId);
    expect(view.questions).toHaveLength(20);
    expect(count(db, "attempts")).toBe(1);
    db.close();
  });
  it("cancels a question build without publishing a late reply", async () => {
    const { db, planId } = notesFixture();
    const runner = createRunner(db, () => {});
    let release!: () => void;
    let began = false;
    registerSimulationJobs(db, runner, async (input) => {
      began = true;
      await new Promise<void>((r) => {
        release = r;
      });
      return writer(input);
    });
    const { jobId } = enqueueSimulation(db, planId) as { jobId: string };
    while (!began) await new Promise((r) => setTimeout(r, 1));
    runner.cancel(jobId);
    release();
    await buildState(db, planId, "cancelled");
    await new Promise((r) => setTimeout(r, 10));
    expect(count(db, "attempts")).toBe(0);
    expect(count(db, "items")).toBe(0);
    db.close();
  });
  it("keeps repeated question scores on their own topics", () => {
    const { db, planId } = fixture();
    const topics = db
      .prepare("SELECT id FROM topics WHERE plan_id=? ORDER BY position")
      .all(planId) as { id: string }[];
    recordTopicScores(
      db,
      planId,
      topics.map((t) => ({ topicId: t.id })),
      [{ score: 1 }, { score: 0 }],
      Date.now(),
    );
    const rows = db
      .prepare(
        "SELECT payload_json FROM learning_events WHERE kind='answer_given' ORDER BY created_at",
      )
      .all() as { payload_json: string }[];
    expect(rows.map((r) => JSON.parse(r.payload_json).score)).toEqual([1, 0]);
    db.close();
  });
});
