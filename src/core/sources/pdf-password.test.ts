import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { extractByExt, lockedPdf } from "./documents";
import { sourceHandlers } from "./handlers";
import { markStoppedImport, registerSourceJobs } from "./jobs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const PASSWORD = "Carnot-1824";

// The real extractors run in this thread instead of the worker, with whatever password the job hands them.
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-pdf-password-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const runner = createRunner(db, (job) => markStoppedImport(db, job));
  const handlers = sourceHandlers(db, workspace, runner);
  const seen: Array<string | undefined> = [];
  registerSourceJobs(db, workspace, runner, async (input) => {
    seen.push(input.password);
    return { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext, input.password) };
  });
  const path = join(workspace, "Dispense.pdf");
  writeFileSync(path, lockedPdf("Il rendimento di una macchina termica", PASSWORD));
  return { workspace, db, runner, handlers, path, seen };
}
// With a runner, an import is queued and the result names its job.
const queue = async (handlers: ReturnType<typeof sourceHandlers>, path: string) =>
  (await handlers.importFile({ path })) as { sourceId: string; jobId?: string };
const job = (db: ReturnType<typeof openDatabase>, id: string) => () =>
  db.prepare(`SELECT state, error FROM jobs WHERE id = ?`).get(id);

/** Every value in every table, so a test can check that something was never written. */
function everything(db: ReturnType<typeof openDatabase>): string {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
  return tables
    .map(({ name }) => {
      try {
        return JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all());
      } catch {
        // Virtual tables of extensions that cannot be read whole.
        return "";
      }
    })
    .join("\n");
}

describe("a PDF locked with a password", () => {
  it("stops with a named error, then reads with the password the student gives for that read only", async () => {
    const { db, handlers, path, seen } = setup();
    const { jobId, sourceId } = await queue(handlers, path);
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toEqual({ state: "failed", error: "pdf-password-required" });
    // The library row says why, and names the job a password answers.
    expect(handlers.list().find((source) => source.id === sourceId)).toMatchObject({
      status: "failed",
      error: "pdf-password-required",
      errorJobId: jobId,
    });

    handlers.unlockPdf({ jobId: jobId!, password: "sbagliata" });
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toEqual({ state: "failed", error: "pdf-password-wrong" });

    handlers.unlockPdf({ jobId: jobId!, password: PASSWORD });
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toEqual({ state: "succeeded", error: null });
    expect(db.prepare(`SELECT status FROM sources WHERE id = ?`).get(sourceId)).toEqual({ status: "ready" });
    expect(db.prepare(`SELECT text FROM passages WHERE source_id = ?`).all(sourceId)).toEqual([
      { text: "Il rendimento di una macchina termica" },
    ]);
    expect(seen).toEqual([undefined, "sbagliata", PASSWORD]);
    // Neither password was written anywhere: not in the job's input, its error, the source or any other row.
    const stored = everything(db);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain("sbagliata");
    db.close();
  });

  it("is used for one read: a retry or a resume without a new password asks again", async () => {
    const { db, runner, handlers, path, seen } = setup();
    const { jobId } = await queue(handlers, path);
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toMatchObject({ state: "failed" });
    handlers.unlockPdf({ jobId: jobId!, password: "sbagliata" });
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toMatchObject({ error: "pdf-password-wrong" });
    runner.retry(jobId!);
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toEqual({ state: "failed", error: "pdf-password-required" });
    expect(seen).toEqual([undefined, "sbagliata", undefined]);
    db.close();
  });

  it("is refused for any job that did not stop on a password", async () => {
    const { db, runner, handlers, workspace } = setup();
    const text = join(workspace, "note.txt");
    writeFileSync(text, "Il primo principio della termodinamica.");
    const { jobId } = await queue(handlers, text);
    await expect.poll(job(db, jobId!), { timeout: 15_000 }).toMatchObject({ state: "succeeded" });
    expect(() => handlers.unlockPdf({ jobId: jobId!, password: PASSWORD })).toThrow(
      expect.objectContaining({ messageKey: "sources.pdfPassword.unavailable" }),
    );
    expect(() => handlers.unlockPdf({ jobId: "missing", password: PASSWORD })).toThrow(
      expect.objectContaining({ messageKey: "sources.pdfPassword.unavailable" }),
    );
    expect(runner.list()).toEqual([]);
    db.close();
  });
});
