import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { extractPlain } from "./documents";
import { MODEL_FILES, setEmbeddingConsent } from "./embed";
import { enqueueSourceFile, registerSourceJobs } from "./jobs";

// The embedding worker is replaced by one that points every text the same way; the job code around it is real.
vi.mock("./worker-client", async (original) => {
  const real = await original<typeof import("./worker-client")>();
  return {
    ...real,
    runSourceWorker: (name: string, input: { texts?: string[] }) =>
      name === "embed-worker"
        ? Promise.resolve(input.texts!.map(() => Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0))))
        : Promise.reject(new Error("unexpected worker")),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("SRC-08 compares a source with the plans that use it once it is indexed, and keeps the result", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-syllabus-job-"));
  dirs.push(workspace);
  const model = join(workspace, "models", "e5");
  for (const name of Object.keys(MODEL_FILES)) {
    mkdirSync(dirname(join(model, name)), { recursive: true });
    writeFileSync(join(model, name), "");
  }
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, true);
  db.prepare(`INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Fisica', 'ready', 1, 1)`).run();
  const runner = createRunner(db, () => {});
  registerSourceJobs(db, workspace, runner, async () => {
    // The source row exists by now, so the plan can use it before the comparison runs.
    const row = db.prepare(`SELECT id FROM sources`).get() as { id: string };
    db.prepare(`INSERT OR IGNORE INTO plan_sources (plan_id, source_id) VALUES ('plan', ?)`).run(row.id);
    return { document: extractPlain("Il calore passa dal corpo caldo al corpo freddo.", false) };
  });
  const path = join(workspace, "dispensa.txt");
  writeFileSync(path, "x");
  const { jobId, sourceId } = await enqueueSourceFile(db, workspace, runner, path);
  await expect.poll(() => db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(jobId)).toEqual({ state: "succeeded" });
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(`syllabus.${sourceId}`) as { value_json: string };
  const stored = JSON.parse(row.value_json) as { checks: Array<{ planId: string; state: string; sections: number; off: number }> };
  expect(stored.checks).toMatchObject([{ planId: "plan", state: "checked", sections: 1, off: 0 }]);
  db.close();
});
