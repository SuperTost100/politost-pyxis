import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { sourceHandlers } from "./handlers";
import { enqueueReextract, enqueueSourceFile, markStoppedImport, registerSourceJobs } from "./jobs";
import { extractPlain } from "./documents";
import { retrieve } from "./retrieve";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const png = PNG.sync.write(new PNG({ width: 8, height: 8 }));
const okOcr = async () => ({ document: { pages: [{ text: "ocr text", locator: { page: 1 }, section: "text" }], scanned: false } });

// The runner is wired to the same hook core/index.ts uses, so a stopped job leaves its source in the stopped state.
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-import-stop-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('vision', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-4-6" }),
  );
  const runner = createRunner(db, (job) => markStoppedImport(db, job));
  const path = join(workspace, "note.png");
  writeFileSync(path, png);
  return { workspace, db, runner, path };
}
const jobState = (db: ReturnType<typeof openDatabase>, id: string) => () =>
  (db.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as { state: string }).state;
const sourceStatus = (db: ReturnType<typeof openDatabase>, id: string) =>
  (db.prepare("SELECT status FROM sources WHERE id = ?").get(id) as { status: string }).status;

describe("a stopped photo import does not stay extracting", () => {
  it("shows failed when the vision engine fails and local OCR has no data", async () => {
    const { workspace, db, runner, path } = setup();
    registerSourceJobs(
      db,
      workspace,
      runner,
      async () => {
        throw new Error("ocr-data-missing");
      },
      {
        run: async () => {
          throw new Error("engine exploded");
        },
      },
    );
    const result = await enqueueSourceFile(db, workspace, runner, path);
    expect(db.prepare("SELECT kind FROM jobs WHERE id = ?").get(result.jobId)).toEqual({ kind: "source-import-vision" });
    await expect.poll(jobState(db, result.jobId)).toBe("failed");
    expect(sourceStatus(db, result.sourceId)).toBe("failed");
  });

  it("shows cancelled when the job is cancelled mid-vision", async () => {
    const { workspace, db, runner, path } = setup();
    registerSourceJobs(db, workspace, runner, okOcr, {
      run: (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
          setTimeout(() => runner.cancel(result.jobId), 5);
        }),
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect.poll(jobState(db, result.jobId)).toBe("cancelled");
    expect(sourceStatus(db, result.sourceId)).toBe("cancelled");
  });

  it("a re-extract that stops keeps the earlier reading's status", async () => {
    const { workspace, db, runner, path } = setup();
    let fail = false;
    registerSourceJobs(db, workspace, runner, async () => {
      if (fail) throw new Error("ocr-data-missing");
      return okOcr();
    }, {
      run: async () => {
        if (fail) throw new Error("engine exploded");
        return { text: "first reading", model: "m", provider: "claude", inputTokens: 1 };
      },
    });
    const first = await enqueueSourceFile(db, workspace, runner, path);
    await expect.poll(jobState(db, first.jobId)).toBe("succeeded");
    expect(sourceStatus(db, first.sourceId)).toBe("ready");
    fail = true;
    const again = enqueueReextract(db, workspace, runner, first.sourceId, false);
    await expect.poll(jobState(db, again.jobId!)).toBe("failed");
    expect(sourceStatus(db, first.sourceId)).toBe("ready");
  });

  it("startup marks a photo whose vision import was interrupted, and leaves a re-extract's source alone", () => {
    const { workspace, db } = setup();
    const insert = (id: string, status: string, params: object) => {
      db.prepare(
        `INSERT INTO sources (id, kind, title, status, mime, created_at, updated_at) VALUES (?, 'image', ?, ?, 'image/png', 1, 1)`,
      ).run(id, id, status);
      db.prepare(
        `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES (?, 'source-import-vision', ?, 'running', 0, 1, 1)`,
      ).run(`job-${id}`, JSON.stringify({ sourceId: id, ...params }));
    };
    insert("fresh", "extracting", {});
    insert("again", "failed", { reextract: 1 });
    // A restart: the runner turns running jobs into interrupted, then the handlers sweep the sources.
    const runner = createRunner(db, () => {});
    sourceHandlers(db, workspace, runner);
    expect(sourceStatus(db, "fresh")).toBe("interrupted");
    expect(sourceStatus(db, "again")).toBe("failed");
  });

  it("startup resumes an import a quit cut off, and leaves a photo waiting for its vision engine", async () => {
    const { workspace, db, runner, path } = setup();
    // The first process starts a text import and a photo import, and both are cut off while reading.
    registerSourceJobs(db, workspace, runner, () => new Promise(() => undefined), {
      vision: () => new Promise(() => undefined),
    });
    const text = join(workspace, "energia.txt");
    writeFileSync(text, "La conservazione dell'energia meccanica vale senza attrito.");
    const imported = await enqueueSourceFile(db, workspace, runner, text);
    const photo = await enqueueSourceFile(db, workspace, runner, path);
    await expect.poll(jobState(db, imported.jobId)).toBe("running");
    await expect.poll(jobState(db, photo.jobId)).toBe("running");
    // The next start: running jobs become interrupted, then the source handlers sweep them.
    const next = createRunner(db, (job) => markStoppedImport(db, job), undefined, true);
    sourceHandlers(db, workspace, next);
    expect(jobState(db, imported.jobId)()).toBe("queued");
    expect(sourceStatus(db, imported.sourceId)).toBe("extracting");
    expect(jobState(db, photo.jobId)()).toBe("interrupted");
    expect(sourceStatus(db, photo.sourceId)).toBe("interrupted");
    registerSourceJobs(db, workspace, next, async (input) => ({
      document: extractPlain(readFileSync(input.path, "utf8"), false),
    }));
    next.activate();
    await expect.poll(jobState(db, imported.jobId)).toBe("succeeded");
    expect(sourceStatus(db, imported.sourceId)).toBe("ready");
    expect(jobState(db, photo.jobId)()).toBe("interrupted");
  });

  describe("a stopped replacement keeps the earlier version in use", () => {
    // A text source is imported, then replaced by a file whose reading fails, is cancelled, or is cut off.
    async function replaced(stop: "fail" | "cancel") {
      const { workspace, db, runner } = setup();
      let replacing = false;
      let jobId = "";
      registerSourceJobs(db, workspace, runner, async (_input, signal) => {
        if (!replacing) return { document: extractPlain("La conservazione dell'energia meccanica vale senza attrito.", false) };
        if (stop === "fail") throw new Error("archive-corrupt");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
          setTimeout(() => runner.cancel(jobId), 5);
        });
      });
      const first = join(workspace, "energia.txt");
      writeFileSync(first, "energia");
      const imported = await enqueueSourceFile(db, workspace, runner, first);
      await expect.poll(jobState(db, imported.jobId)).toBe("succeeded");
      replacing = true;
      const second = join(workspace, "energia-2.txt");
      writeFileSync(second, "energia 2");
      jobId = (await enqueueSourceFile(db, workspace, runner, second, imported.sourceId)).jobId;
      await expect.poll(jobState(db, jobId)).toBe(stop === "fail" ? "failed" : "cancelled");
      return { db, sourceId: imported.sourceId };
    }

    it("after a failure", async () => {
      const { db, sourceId } = await replaced("fail");
      expect(sourceStatus(db, sourceId)).toBe("ready");
      const found = retrieve(db, "conservazione energia meccanica");
      expect(found.hits.map((hit) => hit.sourceId)).toContain(sourceId);
    });

    it("after a cancel", async () => {
      const { db, sourceId } = await replaced("cancel");
      expect(sourceStatus(db, sourceId)).toBe("ready");
    });

    it("after a restart cut it off", () => {
      const { workspace, db } = setup();
      db.prepare(
        `INSERT INTO sources (id, kind, title, status, mime, created_at, updated_at) VALUES ('scan', 'pdf', 'scan', 'extracting', 'application/pdf', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO jobs (id, kind, params_json, state, progress, created_at, updated_at) VALUES ('job-scan', 'source-import', ?, 'running', 0, 1, 1)`,
      ).run(JSON.stringify({ sourceId: "scan", replace: true, previousStatus: "needs-ocr" }));
      sourceHandlers(db, workspace, createRunner(db, () => {}));
      expect(sourceStatus(db, "scan")).toBe("needs-ocr");
    });
  });

  it("removing a source cancels its import", async () => {
    const { workspace, db, runner } = setup();
    // The handlers register the real import jobs; the stand-in that never finishes replaces them.
    const handlers = sourceHandlers(db, workspace, runner);
    registerSourceJobs(db, workspace, runner, (_input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")));
      }),
    );
    const path = join(workspace, "lento.txt");
    writeFileSync(path, "testo");
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect.poll(jobState(db, result.jobId)).toBe("running");
    expect(handlers.remove({ sourceId: result.sourceId, confirmed: false })).toEqual({ removed: true, inUse: false });
    await expect.poll(jobState(db, result.jobId)).toBe("cancelled");
    expect(sourceStatus(db, result.sourceId)).toBe("removed");
  });
});
