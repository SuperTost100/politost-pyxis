import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { enqueueSourceFile, registerSourceJobs } from "./jobs";
import { extractPlain, storeExtracted } from "./documents";
import { sourceHandlers } from "./handlers";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("SRC-11 retries extraction from the stored original and creates passages only once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-import-job-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const runner = createRunner(db, () => {});
  let reads = 0;
  registerSourceJobs(db, workspace, runner, async (input) => {
    reads += 1;
    if (reads === 1) throw new Error("fixture-extraction-failed");
    return { document: extractPlain(await readFile(input.path, "utf8"), false) };
  });
  const path = join(workspace, "original.txt");
  writeFileSync(path, "La velocità descrive lo spostamento nel tempo.");
  const result = await enqueueSourceFile(db, workspace, runner, path);
  await expect.poll(() => runner.list().find((job) => job.id === result.jobId)?.state).toBe("failed");
  rmSync(path);
  runner.retry(result.jobId);
  await expect.poll(() => db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(result.jobId)).toEqual({ state: "succeeded" });
  expect(reads).toBe(2);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`).get(result.sourceId)).toEqual({ n: 1 });
  runner.retry(result.jobId);
  expect(reads).toBe(2);
  db.close();
});

it("NFR-04 retains the extraction checkpoint after cancellation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-import-cancel-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  let jobId = "";
  let cancelled = false;
  const runner = createRunner(db, (job) => {
    if (!cancelled && job.stepLabel === "sources.jobs.passages") {
      cancelled = true;
      runner.cancel(job.id);
    }
  });
  let reads = 0;
  registerSourceJobs(db, workspace, runner, async () => {
    reads += 1;
    return { document: extractPlain("Energia e lavoro", false) };
  });
  const path = join(workspace, "source.txt");
  writeFileSync(path, "Energia e lavoro");
  jobId = (await enqueueSourceFile(db, workspace, runner, path)).jobId;
  await expect.poll(() => runner.list().find((job) => job.id === jobId)?.state).toBe("cancelled");
  expect(db.prepare(`SELECT state FROM job_steps WHERE job_id = ? AND name = 'extract'`).get(jobId)).toEqual({ state: "succeeded" });
  runner.retry(jobId);
  await expect.poll(() => db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(jobId)).toEqual({ state: "succeeded" });
  expect(reads).toBe(1);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM passages`).get()).toEqual({ n: 1 });
  db.close();
});

it("SRC-12 replacement preserves the original document format and blob for citations", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-replace-job-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const original = storeExtracted(db, workspace, {
    title: "Physics", kind: "pdf", mime: "application/pdf", ext: "pdf", bytes: new Uint8Array([1, 2, 3]),
    extracted: { pages: [{ text: "Original cited text", locator: { page: 1 }, section: "p. 1" }], scanned: false },
  });
  const oldId = (db.prepare(`SELECT id FROM passages WHERE source_id = ?`).get(original.sourceId) as { id: string }).id;
  const runner = createRunner(db, () => {});
  registerSourceJobs(db, workspace, runner, async (input) => ({ document: extractPlain(await readFile(input.path, "utf8"), false) }));
  const path = join(workspace, "replacement.txt");
  writeFileSync(path, "Replacement text");
  const next = await enqueueSourceFile(db, workspace, runner, path, original.sourceId);
  await expect.poll(() => db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(next.jobId)).toEqual({ state: "succeeded" });
  const handlers = sourceHandlers(db, workspace);
  expect(handlers.viewerDocument({ passageId: oldId })?.kind).toBe("pdf");
  expect(handlers.viewerDocument({ passageId: oldId })?.blobSha).toBeTruthy();
  expect(handlers.viewerDocument({ sourceId: original.sourceId })?.kind).toBe("text");
  expect(db.prepare(`SELECT COUNT(*) AS n FROM source_documents WHERE source_id = ?`).get(original.sourceId)).toEqual({ n: 2 });
  db.close();
});
