import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { MODEL_FILES, setEmbeddingConsent } from "../sources/embed";
import { sourceHandlers } from "../sources/handlers";
import { importSmartbook } from "../sources/smartbook";
import { planHandlers } from "./handlers";
import { planBuildState } from "./jobs";

// Plan texts point one way and every passage another, so the one section of the source is off every plan. The job code
// around the embedding worker, the queue and the stored result are real.
vi.mock("../sources/worker-client", async (original) => {
  const real = await original<typeof import("../sources/worker-client")>();
  return {
    ...real,
    runSourceWorker: (name: string, input: { texts?: string[] }) =>
      name === "embed-worker"
        ? Promise.resolve(
            input.texts!.map((text) =>
              Array.from({ length: 384 }, (_, index) =>
                index === (text.startsWith("query:") ? 0 : 1) ? 1 : 0,
              ),
            ),
          )
        : Promise.reject(new Error("unexpected worker")),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const book = () =>
  zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "physics",
        title: "Fisica",
        access: "public",
        chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
      }),
    ),
    "chapters/01.md": strToU8(
      "## p1 | Velocità\nLa velocità descrive il movimento.\n\n## p2 | Tempo\nIl tempo si misura in secondi.\n",
    ),
  });

const response = (data: unknown) => ({
  text: JSON.stringify(data),
  structured: data,
  provider: "claude" as const,
  model: "fixture",
  inputTokens: 1,
});
const run: GenerateInput["run"] = async (input) => {
  if (input.system?.startsWith("Write"))
    return response({ markdown: "Il moto [P1]." });
  const content = JSON.parse(input.prompt) as {
    passages: Array<{ id: string }>;
  };
  return response({
    questions: Array.from({ length: 10 }, (_, i) => ({
      stem: `Domanda ${i}`,
      options: ["a", "b", "c", "d"],
      correct: 0,
      topicIndex: 0,
      passageIds: [content.passages[0]!.id],
      explanation: "Spiegazione",
    })),
  });
};

function setup(consent = true) {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-syllabus-queue-"));
  dirs.push(workspace);
  const model = join(workspace, "models", "e5");
  for (const name of Object.keys(MODEL_FILES)) {
    mkdirSync(dirname(join(model, name)), { recursive: true });
    writeFileSync(join(model, name), "");
  }
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, consent);
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const runner = createRunner(db, () => {});
  const sources = sourceHandlers(db, workspace, runner);
  const plans = planHandlers(db, workspace, runner, run);
  // The usual flow: the source is imported and indexed first, with no plan to compare against.
  const sourceId = importSmartbook(db, book()).sourceId;
  return { db, runner, sources, plans, sourceId };
}

const checkJobs = (db: ReturnType<typeof openDatabase>) =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'source-index'`)
      .get() as { n: number }
  ).n;
const idle = (db: ReturnType<typeof openDatabase>) => () =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE kind = 'source-index' AND state IN ('queued', 'running')`,
    )
    .get();
const stored = (db: ReturnType<typeof openDatabase>, sourceId: string) =>
  db
    .prepare(`SELECT value_json FROM settings WHERE key = ?`)
    .get(`syllabus.${sourceId}`) as { value_json: string } | undefined;

describe("SRC-08 comparison after the plan is made or edited", () => {
  it("compares a source that was imported before its plan, so the library shows the warning without opening the drawer", async () => {
    const { db, sources, plans, sourceId } = setup();
    expect(stored(db, sourceId)).toBeUndefined();
    const built = await plans.create({
      title: "Fisica",
      sourceIds: [sourceId],
    });
    await expect
      .poll(() => planBuildState(db, built.planId)?.state)
      .toBe("succeeded");
    await expect.poll(idle(db)).toEqual({ n: 0 });
    expect(checkJobs(db)).toBe(1);
    expect(JSON.parse(stored(db, sourceId)!.value_json).checks).toMatchObject([
      { planId: built.planId, state: "checked", sections: 1, off: 1 },
    ]);
    // The list reads only what the job stored.
    expect(
      sources.list().find((source) => source.id === sourceId),
    ).toMatchObject({ syllabusOff: 1 });
    expect(checkJobs(db)).toBe(1);
    db.close();
  });

  it("compares again after a plan edit changes what the result depends on, once per change and not when nothing changed", async () => {
    const { db, sources, plans, sourceId } = setup();
    const built = await plans.create({
      title: "Fisica",
      sourceIds: [sourceId],
    });
    await expect
      .poll(() => planBuildState(db, built.planId)?.state)
      .toBe("succeeded");
    await expect.poll(idle(db)).toEqual({ n: 0 });
    const edit = (title: string) =>
      plans.settings({
        planId: built.planId,
        title,
        target: 0.75,
        examAt: null,
      });
    // Saving the same settings changes nothing the result depends on.
    edit("Fisica");
    expect(checkJobs(db)).toBe(1);
    // The stored result is stale at once, so the library shows no warning until the job has stored a new one.
    edit("Fisica generale");
    expect(
      sources.list().find((source) => source.id === sourceId)!.syllabusOff,
    ).toBeUndefined();
    // A second edit before the first check ran joins it.
    edit("Fisica 1");
    expect(checkJobs(db)).toBe(2);
    await expect.poll(idle(db)).toEqual({ n: 0 });
    expect(
      sources.list().find((source) => source.id === sourceId),
    ).toMatchObject({ syllabusOff: 1 });
    expect(
      JSON.parse(stored(db, sourceId)!.value_json).checks[0].planTitle,
    ).toBe("Fisica 1");
    db.close();
  });

  it("compares again when a topic is renamed and the topic tree is rebuilt and applied", async () => {
    const { db, sources, plans, sourceId } = setup();
    const built = await plans.create({
      title: "Fisica",
      sourceIds: [sourceId],
    });
    await expect
      .poll(() => planBuildState(db, built.planId)?.state)
      .toBe("succeeded");
    await expect.poll(idle(db)).toEqual({ n: 0 });
    // A topic edit with no queue of its own: the stored result is stale until something compares again.
    db.prepare(
      "UPDATE topics SET title = 'Moti e tempo' WHERE plan_id = ?",
    ).run(built.planId);
    expect(
      sources.list().find((source) => source.id === sourceId)!.syllabusOff,
    ).toBeUndefined();
    const { jobId } = plans.rebuildStart({ planId: built.planId });
    await expect
      .poll(() => plans.rebuildState({ planId: built.planId })?.state)
      .toBe("succeeded");
    expect(checkJobs(db)).toBe(1);
    plans.rebuildApply({ planId: built.planId, jobId });
    expect(checkJobs(db)).toBe(2);
    await expect.poll(idle(db)).toEqual({ n: 0 });
    expect(
      sources.list().find((source) => source.id === sourceId),
    ).toMatchObject({ syllabusOff: 1 });
    db.close();
  });

  it("queues nothing while the local search model is off", async () => {
    const { db, plans, sourceId } = setup(false);
    const built = await plans.create({
      title: "Fisica",
      sourceIds: [sourceId],
    });
    await expect
      .poll(() => planBuildState(db, built.planId)?.state)
      .toBe("succeeded");
    expect(checkJobs(db)).toBe(0);
    expect(stored(db, sourceId)).toBeUndefined();
    db.close();
  });
});
