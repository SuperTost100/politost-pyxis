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

// While `hang` is set, the embedding never finishes until it is cancelled, so the import stops during its vectors step.
// `onEmbed` lets a test look at the source while a batch is being embedded.
let hang = true;
let onEmbed: (() => void) | undefined;
vi.mock("./worker-client", () => ({
  runSourceWorker: (_name: string, input: { texts: string[] }, signal?: AbortSignal) =>
    (onEmbed?.(), hang)
      ? new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))))
      : Promise.resolve(input.texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)))),
}));

const dirs: string[] = [];
afterEach(() => {
  hang = true;
  onEmbed = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const TEXT = "Il teorema di Bernoulli lega pressione e velocità in un fluido ideale.";

async function importUntilIndexing(scanned = false) {
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
  registerSourceJobs(db, workspace, runner, async () => ({ document: { ...extractPlain(TEXT, false), scanned } }));
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

  it("leaves the source ready when a restart cuts indexing off, while the resumed job indexes it again", async () => {
    const { workspace, db, runner, sourceId, jobId } = await importUntilIndexing();
    // The first process dies in the vectors step. Its own job is stopped here, then its rows are put back the way a
    // crash leaves them (job and step running, source indexing), so no first-process work is left to write later.
    runner.cancel(jobId);
    await expect.poll(state(db, jobId)).toBe("cancelled");
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(jobId);
    db.prepare("UPDATE job_steps SET state = 'running' WHERE job_id = ? AND name = 'vectors'").run(jobId);
    db.prepare("UPDATE sources SET status = 'indexing' WHERE id = ?").run(sourceId);
    // A restart: the new runner turns the running job into an interrupted one, the handlers resume its local
    // indexing and sweep the sources. Nothing runs until the runner is activated.
    const next = createRunner(db, (job) => markStoppedImport(db, job), undefined, true);
    sourceHandlers(db, workspace, next);
    expect(state(db, jobId)()).toBe("queued");
    expect(status(db, sourceId)).toBe("ready");
    const during: string[] = [];
    onEmbed = () => during.push(status(db, sourceId));
    hang = false;
    next.activate();
    await expect.poll(state(db, jobId)).toBe("succeeded");
    // The source stayed ready and findable while its vectors were redone, and the job ran once.
    expect(during).toEqual(["ready"]);
    expect(status(db, sourceId)).toBe("ready");
    expect(retrieve(db, "Bernoulli pressione").hits.map((hit) => hit.sourceId)).toContain(sourceId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM passages_vec").get()).not.toEqual({ n: 0 });
    db.close();
  });

  it.each(["ready", "ocr-queued"])("a retried scan import leaves the status OCR gave it meanwhile (%s)", async (afterOcr) => {
    const { db, runner, sourceId, jobId } = await importUntilIndexing(true);
    runner.cancel(jobId);
    await expect.poll(state(db, jobId)).toBe("cancelled");
    expect(status(db, sourceId)).toBe("needs-ocr");
    // The student reads the scan with OCR, then retries the stopped import, which adds the vectors.
    db.prepare("UPDATE sources SET status = ? WHERE id = ?").run(afterOcr, sourceId);
    hang = false;
    runner.retry(jobId);
    await expect.poll(state(db, jobId)).toBe("succeeded");
    expect(status(db, sourceId)).toBe(afterOcr);
    expect(db.prepare("SELECT COUNT(*) AS n FROM passages_vec").get()).not.toEqual({ n: 0 });
    db.close();
  });
});
