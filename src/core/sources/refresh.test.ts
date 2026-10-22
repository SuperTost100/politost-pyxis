import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { extractByExt, extractPlain, storeExtracted } from "./documents";
import { onePagePdf } from "./test-pdf";
import { sourceHandlers } from "./handlers";
import { enqueueRefresh, enqueueSourceFile, markStoppedImport, registerSourceJobs } from "./jobs";
import type { PageSnapshot } from "./link";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const URL_SAVED = "https://corsi.example.it/fisica/appunti";
const OLD_PAGE = "# Primo principio\n\nIl calore scambiato cambia l'energia interna del sistema.";

// A course page saved from a link, renamed by the student, used by one plan whose lesson cites its only passage.
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-refresh-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const runner = createRunner(db, (job) => markStoppedImport(db, job));
  registerSourceJobs(db, workspace, runner, async (input) => ({
    document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext),
  }));
  const stored = storeExtracted(db, workspace, {
    title: "Appunti",
    kind: "link",
    mime: "text/markdown",
    ext: ".md",
    bytes: new TextEncoder().encode(OLD_PAGE),
    extracted: extractPlain(OLD_PAGE, true),
    originUrl: URL_SAVED,
    fetchedAt: 1_000,
  });
  db.prepare(`UPDATE sources SET title = 'I miei appunti' WHERE id = ?`).run(stored.sourceId);
  const passageId = (db.prepare(`SELECT id FROM passages WHERE source_id = ?`).get(stored.sourceId) as { id: string }).id;
  db.prepare(`INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Esame', 'ready', 1, 1)`).run();
  db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES ('plan', ?)`).run(stored.sourceId);
  db.prepare(`INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('lesson', 'plan', 'lesson', '{}', 1)`).run();
  db.prepare(`INSERT INTO item_passages (item_id, passage_id) VALUES ('lesson', ?)`).run(passageId);
  const fetched: string[] = [];
  const page = (snapshot: Partial<PageSnapshot>) => async (url: string) => {
    fetched.push(url);
    return { finalUrl: url, title: "Pagina", markdown: "", pdf: null, ...snapshot };
  };
  return { workspace, db, runner, sourceId: stored.sourceId, passageId, fetched, page };
}
const state = (db: ReturnType<typeof openDatabase>, jobId: string) => () =>
  db.prepare(`SELECT state, error FROM jobs WHERE id = ?`).get(jobId);
const sourceRow = (db: ReturnType<typeof openDatabase>, id: string) =>
  db.prepare(`SELECT title, kind, mime, blob_sha AS sha, origin_url AS url, fetched_at AS fetchedAt, status FROM sources WHERE id = ?`).get(id) as {
    title: string;
    kind: string;
    mime: string;
    sha: string;
    url: string;
    fetchedAt: number;
    status: string;
  };

describe("check a link source for a new version", () => {
  it("asks before fetching a source that a plan uses", async () => {
    const { db, runner, workspace, sourceId, fetched, page } = setup();
    expect(await enqueueRefresh(db, workspace, runner, sourceId, false, undefined, page({ markdown: "nuovo" }))).toEqual({
      started: false,
      inUse: 1,
    });
    expect(fetched).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 0 });
    db.close();
  });

  it("starts nothing when the page is the copy already saved", async () => {
    const { db, runner, workspace, sourceId, fetched, page } = setup();
    const before = sourceRow(db, sourceId);
    expect(await enqueueRefresh(db, workspace, runner, sourceId, true, undefined, page({ markdown: OLD_PAGE }))).toEqual({
      started: false,
      inUse: 1,
      unchanged: true,
    });
    expect(fetched).toEqual([URL_SAVED]);
    expect(sourceRow(db, sourceId)).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get()).toEqual({ n: 0 });
    db.close();
  });

  it("reads a changed page as the next version of the same source and keeps old citations on the old copy", async () => {
    const { db, runner, workspace, sourceId, passageId, page } = setup();
    const before = sourceRow(db, sourceId);
    const changed = "# Primo principio\n\nIl calore scambiato e il lavoro compiuto cambiano l'energia interna del sistema.";
    const result = await enqueueRefresh(
      db,
      workspace,
      runner,
      sourceId,
      true,
      undefined,
      page({ markdown: changed, finalUrl: `${URL_SAVED}/v2` }),
    );
    expect(result).toMatchObject({ started: true, inUse: 1 });
    // While the new page is read, the source keeps its saved copy and stays usable.
    expect(sourceRow(db, sourceId)).toEqual(before);
    await expect.poll(state(db, result.jobId!), { timeout: 15_000 }).toEqual({ state: "succeeded", error: null });
    const after = sourceRow(db, sourceId);
    // Same source, the student's name kept; its file, address and fetch time are the new copy's.
    expect(after).toMatchObject({ title: "I miei appunti", kind: "link", mime: "text/markdown", url: `${URL_SAVED}/v2`, status: "ready" });
    expect(after.sha).not.toBe(before.sha);
    expect(after.fetchedAt).toBeGreaterThan(before.fetchedAt);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT text FROM passages WHERE source_id = ? AND version = 2`).all(sourceId)).toEqual([{ text: changed }]);
    // The lesson still cites the old passage, marked out of date, and the citation opens the copy saved then.
    expect(db.prepare(`SELECT stale FROM item_passages WHERE passage_id = ?`).get(passageId)).toEqual({ stale: 1 });
    const handlers = sourceHandlers(db, workspace, runner);
    expect(handlers.viewerDocument({ passageId })).toMatchObject({ sourceId, blobSha: before.sha });
    expect(handlers.viewerDocument({ sourceId })).toMatchObject({ sourceId, blobSha: after.sha });
    db.close();
  });

  it("takes a page that has become a PDF as one", async () => {
    const { db, runner, workspace, sourceId, page } = setup();
    const result = await enqueueRefresh(
      db,
      workspace,
      runner,
      sourceId,
      true,
      undefined,
      page({ pdf: onePagePdf("Il primo principio della termodinamica") }),
    );
    await expect.poll(state(db, result.jobId!), { timeout: 15_000 }).toMatchObject({ state: "succeeded" });
    expect(sourceRow(db, sourceId)).toMatchObject({ kind: "pdf", mime: "application/pdf", status: "ready" });
    expect(db.prepare(`SELECT tree_json FROM source_documents WHERE source_id = ? AND version = 2`).get(sourceId)).toMatchObject({
      tree_json: expect.stringContaining('"kind":"pdf"'),
    });
    db.close();
  });

  it("keeps the saved copy when the new page has no text, and refuses what has no link or is busy", async () => {
    const { db, runner, workspace, sourceId, passageId, page } = setup();
    const before = sourceRow(db, sourceId);
    const empty = await enqueueRefresh(db, workspace, runner, sourceId, true, undefined, page({ markdown: "   " }));
    await expect.poll(state(db, empty.jobId!), { timeout: 15_000 }).toEqual({ state: "failed", error: "reextract-no-text" });
    expect(sourceRow(db, sourceId)).toEqual(before);
    expect(db.prepare(`SELECT stale FROM item_passages WHERE passage_id = ?`).get(passageId)).toEqual({ stale: 0 });
    // The stopped job holds the source until it is retried or dismissed, as a re-extract does.
    await expect(enqueueRefresh(db, workspace, runner, sourceId, true, undefined, page({ markdown: "x" }))).rejects.toThrow("source-busy");
    db.prepare(`INSERT INTO sources (id, kind, title, status, blob_sha, mime, created_at, updated_at) VALUES ('file', 'text', 'File', 'ready', 'abc', 'text/plain', 1, 1)`).run();
    await expect(enqueueRefresh(db, workspace, runner, "file", true, undefined, page({}))).rejects.toThrow("refresh-unavailable");
    await expect(enqueueRefresh(db, workspace, runner, "missing", true, undefined, page({}))).rejects.toThrow("source-missing");
    db.close();
  });

  it("forgets the address when the source is replaced with a file, so nothing is checked against it", async () => {
    const { db, runner, workspace, sourceId, fetched, page } = setup();
    const file = join(workspace, "Dispense.md");
    writeFileSync(file, "# Secondo principio\n\nL'entropia di un sistema isolato non diminuisce.");
    const replaced = await enqueueSourceFile(db, workspace, runner, file, sourceId);
    await expect.poll(state(db, replaced.jobId), { timeout: 15_000 }).toMatchObject({ state: "succeeded" });
    expect(sourceRow(db, sourceId)).toMatchObject({ url: null, fetchedAt: null, title: "Dispense" });
    await expect(enqueueRefresh(db, workspace, runner, sourceId, true, undefined, page({ markdown: "x" }))).rejects.toThrow(
      "refresh-unavailable",
    );
    // A replacement saved before the address was cleared still has one, but it is not a saved page.
    db.prepare(`UPDATE sources SET origin_url = ?, fetched_at = 1000 WHERE id = ?`).run(URL_SAVED, sourceId);
    await expect(enqueueRefresh(db, workspace, runner, sourceId, true, undefined, page({ markdown: "x" }))).rejects.toThrow(
      "refresh-unavailable",
    );
    expect(fetched).toEqual([]);
    db.close();
  });

  it("is a handler that says what it could not do", async () => {
    const { db, runner, workspace } = setup();
    db.prepare(`INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('book', 'smartbook', 'Libro', 'ready', 1, 1)`).run();
    const handlers = sourceHandlers(db, workspace, runner);
    await expect(handlers.refresh({ sourceId: "book", confirmed: true })).rejects.toMatchObject({
      messageKey: "sources.refreshUnavailable",
    });
    expect(handlers.list().find((source) => source.id === "book")).toMatchObject({ originUrl: null, fetchedAt: null });
    db.close();
  });
});
