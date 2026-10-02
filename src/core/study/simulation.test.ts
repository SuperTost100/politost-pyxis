import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { studyHandlers } from "./handlers";
import {
  listSimulations,
  openSimulation,
  readSimulation,
  recordTopicScores,
  registerSimulationJobs,
  saveSimulationDraft,
  startSimulation,
  submitSimulation,
} from "./simulation";
function fixture() {
  const db = openDatabase(":memory:");
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
const run: GenerateInput["run"] = async () => response();
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
    expect(done.results![1]!.score).toBe(0);
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
    submitSimulation(db, opened.attemptId, {});
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
    const view = submitSimulation(db, opened.attemptId, {});
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
