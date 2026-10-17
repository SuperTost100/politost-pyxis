import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { extractPlain } from "./documents";
import { MODEL_FILES, setEmbeddingConsent } from "./embed";
import { sourceHandlers } from "./handlers";
import { enqueueSourceFile, markStoppedImport, registerSourceJobs } from "./jobs";
import { existingSourceFor } from "./quality";
import { retrieve } from "./retrieve";

// The embedding never finishes until it is cancelled, so the import stops during its vectors step.
vi.mock("./worker-client", () => ({
  runSourceWorker: (_name: string, _input: unknown, signal?: AbortSignal) =>
    new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")))),
}));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const TEXT = "Il teorema di Bernoulli lega pressione e velocità in un fluido ideale.";

async function importUntilIndexing() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-import-indexing-"));
  dirs.push(workspace);
  // The local search model is agreed to and on disk, so the import's vectors step embeds.
  for (const name of Object.keys(MODEL_FILES)) {
    const file = join(workspace, "models", "e5", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "stand-in");
  }
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, true);
  const runner = createRunner(db, (job) => markStoppedImport(db, job));
  registerSourceJobs(db, workspace, runner, async () => ({ document: extractPlain(TEXT, false) }));
  const path = join(workspace, "bernoulli.txt");
  writeFileSync(path, TEXT);
  const result = await enqueueSourceFile(db, workspace, runner, path);
  await expect.poll(() => (db.prepare("SELECT status FROM sources WHERE id = ?").get(result.sourceId) as { status: string }).status).toBe("indexing");
  return { workspace, db, runner, ...result };
}
const state = (db: ReturnType<typeof openDatabase>, id: string) => () =>
  (db.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string }).state;
const status = (db: ReturnType<typeof openDatabase>, id: string) =>
  (db.prepare("SELECT status FROM sources WHERE id = ?").get(id) as { status: string }).status;
const sha = (db: ReturnType<typeof openDatabase>, id: string) =>
  (db.prepare("SELECT blob_sha FROM sources WHERE id = ?").get(id) as { blob_sha: string }).blob_sha;

describe("an import stopped after its passages were stored", () => {
  it("leaves the source ready, findable and recognised as a duplicate when cancelled during indexing", async () => {
    const { db, runner, sourceId, jobId } = await importUntilIndexing();
    runner.cancel(jobId);
    await expect.poll(state(db, jobId)).toBe("cancelled");
    expect(status(db, sourceId)).toBe("ready");
    expect(retrieve(db, "Bernoulli pressione").hits.map((hit) => hit.sourceId)).toContain(sourceId);
    expect(existingSourceFor(db, sha(db, sourceId))).toBe(sourceId);
    db.close();
  });

  it("leaves the source ready when a restart cuts indexing off", async () => {
    const { workspace, db, runner, sourceId, jobId } = await importUntilIndexing();
    // A restart: the new runner turns the running job into an interrupted one, then the handlers sweep the sources.
    sourceHandlers(db, workspace, createRunner(db, () => {}, undefined, true));
    expect(state(db, jobId)()).toBe("interrupted");
    expect(status(db, sourceId)).toBe("ready");
    // The first process still holds the job; stop it before the database closes.
    runner.cancel(jobId);
    await expect.poll(state(db, jobId)).toBe("cancelled");
    db.close();
  });
});
