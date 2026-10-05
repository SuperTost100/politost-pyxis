import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { IpcError } from "../../shared/ipc";
import { extractPlain, storeExtracted } from "./documents";
import { sourceHandlers } from "./handlers";
import { enqueueReextract, registerSourceJobs, type Extraction } from "./jobs";
import { extForMime } from "./manage";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(extract: (input: { path: string; ext: string }) => Promise<Extraction>) {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-reextract-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const runner = createRunner(db, () => {});
  registerSourceJobs(db, workspace, runner, extract as never);
  // A renamed text source that one plan uses, with an item citing its only passage.
  const stored = storeExtracted(db, workspace, {
    title: "Fisica 1",
    kind: "text",
    mime: "text/plain",
    ext: ".txt",
    bytes: new TextEncoder().encode("La velocità descrive lo spostamento.\n\nL'energia si conserva."),
    extracted: extractPlain("Vecchio testo estratto male", false),
  });
  const passageId = (db.prepare(`SELECT id FROM passages WHERE source_id = ?`).get(stored.sourceId) as { id: string }).id;
  db.prepare(`INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Esame', 'ready', 1, 1)`).run();
  db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES ('plan', ?)`).run(stored.sourceId);
  db.prepare(`INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('lesson', 'plan', 'lesson', '{}', 1)`).run();
  db.prepare(`INSERT INTO item_passages (item_id, passage_id) VALUES ('lesson', ?)`).run(passageId);
  db.prepare(`UPDATE sources SET title = 'La mia fisica' WHERE id = ?`).run(stored.sourceId);
  return { workspace, db, runner, sourceId: stored.sourceId, passageId };
}

const done = (db: ReturnType<typeof openDatabase>, jobId: string) => () =>
  db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(jobId);

describe("SRC-12 re-extract from the stored original", () => {
  it("asks before reading again a source that a plan uses, and starts nothing until confirmed", async () => {
    const { db, runner, workspace, sourceId } = setup(async () => ({ document: extractPlain("x", false) }));
    expect(enqueueReextract(db, workspace, runner, sourceId, false)).toEqual({ started: false, inUse: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 0 });
    const started = enqueueReextract(db, workspace, runner, sourceId, true);
    expect(started).toMatchObject({ started: true, inUse: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 1 });
    await expect.poll(done(db, started.jobId!)).toEqual({ state: "succeeded" });
    db.close();
  });

  it("publishes a new version of the same source, keeps its name and file, and marks old citations stale", async () => {
    const seen: Array<{ ext: string; text: string; status: string }> = [];
    const ctx = setup(async (input) => {
      seen.push({ ext: input.ext, text: await readFile(input.path, "utf8"), status: "" });
      // The earlier reading stays usable while the new one is made.
      seen[seen.length - 1]!.status = (ctx.db.prepare(`SELECT status FROM sources WHERE id = ?`).get(ctx.sourceId) as { status: string }).status;
      return { document: extractPlain(await readFile(input.path, "utf8"), false) };
    });
    const { db, runner, workspace, sourceId, passageId } = ctx;
    const before = db.prepare(`SELECT blob_sha, kind, mime FROM sources WHERE id = ?`).get(sourceId);
    const { jobId } = enqueueReextract(db, workspace, runner, sourceId, true);
    await expect.poll(done(db, jobId!)).toEqual({ state: "succeeded" });
    // The job read the stored original, with its real extension, not a copy from anywhere else.
    expect(seen).toEqual([{ ext: ".txt", text: "La velocità descrive lo spostamento.\n\nL'energia si conserva.", status: "ready" }]);
    expect(db.prepare(`SELECT title, blob_sha, kind, mime, status FROM sources WHERE id = ?`).get(sourceId)).toEqual({
      title: "La mia fisica",
      status: "ready",
      ...(before as object),
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT version FROM source_documents WHERE source_id = ? ORDER BY version`).all(sourceId)).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    // Old text is still there for the citation, flagged stale. The new version is what retrieval reads.
    expect(db.prepare(`SELECT text FROM passages WHERE id = ?`).get(passageId)).toEqual({ text: "Vecchio testo estratto male" });
    expect(db.prepare(`SELECT stale FROM item_passages WHERE item_id = 'lesson'`).get()).toEqual({ stale: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ? AND version = 2`).get(sourceId)).toEqual({ n: 2 });
    // The plan still uses the source, and a finished job no longer blocks another read.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plan_sources WHERE source_id = ?`).get(sourceId)).toEqual({ n: 1 });
    db.close();
  });

  it("keeps the earlier reading when the new one finds no text, and says why", async () => {
    const { db, runner, workspace, sourceId, passageId } = setup(async () => ({
      document: { pages: [{ text: "  ", locator: { page: 1 }, section: "p. 1" }], scanned: false },
    }));
    const { jobId } = enqueueReextract(db, workspace, runner, sourceId, true);
    await expect.poll(done(db, jobId!)).toEqual({ state: "failed" });
    expect(db.prepare(`SELECT error FROM jobs WHERE id = ?`).get(jobId)).toEqual({ error: "reextract-no-text" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM source_documents WHERE source_id = ?`).get(sourceId)).toEqual({ n: 1 });
    expect(db.prepare(`SELECT status FROM sources WHERE id = ?`).get(sourceId)).toEqual({ status: "ready" });
    expect(db.prepare(`SELECT stale FROM item_passages WHERE passage_id = ?`).get(passageId)).toEqual({ stale: 0 });
    // A stopped job blocks a second one until it is retried or dismissed, as for a replacement.
    expect(() => enqueueReextract(db, workspace, runner, sourceId, true)).toThrow("source-busy");
    db.close();
  });

  it("refuses what has no stored original to read: a smartbook, a missing file, a removed source", () => {
    const { db, runner, workspace, sourceId } = setup(async () => ({ document: extractPlain("x", false) }));
    db.prepare(`INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('book', 'smartbook', 'Libro', 'ready', 1, 1)`).run();
    expect(() => enqueueReextract(db, workspace, runner, "book", true)).toThrow("reextract-unavailable");
    db.prepare(`UPDATE sources SET blob_sha = ? WHERE id = ?`).run("a".repeat(64), sourceId);
    expect(() => enqueueReextract(db, workspace, runner, sourceId, true)).toThrow("reextract-unavailable");
    db.prepare(`UPDATE sources SET status = 'removed' WHERE id = ?`).run(sourceId);
    expect(() => enqueueReextract(db, workspace, runner, sourceId, true)).toThrow("source-missing");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 0 });
    db.close();
  });

  it("is exposed as a handler with the plan-use confirmation and translated refusals", async () => {
    const { db, runner, workspace, sourceId } = setup(async (input) => ({ document: extractPlain(readFileSync(input.path, "utf8"), false) }));
    const handlers = sourceHandlers(db, workspace, runner);
    expect(await handlers.reextract({ sourceId, confirmed: false })).toEqual({ started: false, inUse: 1 });
    const started = await handlers.reextract({ sourceId, confirmed: true });
    expect(started.started).toBe(true);
    await expect.poll(done(db, started.jobId!)).toEqual({ state: "succeeded" });
    await expect(handlers.reextract({ sourceId: "missing", confirmed: true })).rejects.toThrow(IpcError);
    await expect(sourceHandlers(db, workspace).reextract({ sourceId, confirmed: true })).rejects.toMatchObject({
      messageKey: "sources.reextractUnavailable",
    });
    db.close();
  });

  it("maps a stored type back to the extension its extractor needs", () => {
    expect(extForMime("application/pdf")).toBe(".pdf");
    expect(extForMime("text/markdown")).toBe(".md");
    expect(extForMime("image/jpeg")).toBe(".jpg");
    expect(extForMime("application/vnd.politost.ptsb")).toBeNull();
    expect(extForMime(null)).toBeNull();
  });
});
