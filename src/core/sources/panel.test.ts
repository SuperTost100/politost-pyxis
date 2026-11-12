import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import { fileToOpen, ORIGINAL_CHUNK_MAX, panelPage, panelSource, readOriginal } from "./panel";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pyxis-panel-"));
  dirs.push(root);
  const workspace = join(root, "workspace");
  const folder = join(root, "Università");
  mkdirSync(workspace);
  mkdirSync(folder);
  const db = openDatabase(":memory:");
  const source = (id: string, fields: { kind?: string; status?: string; sha?: string | null; mime?: string; url?: string; title?: string }) => {
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, library, blob_sha, mime, origin_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, 1)`,
    ).run(id, fields.kind ?? "pdf", fields.title ?? "Fisica I", fields.status ?? "ready", fields.sha ?? null, fields.mime ?? null, fields.url ?? null);
  };
  const document = (id: string, sourceId: string, version: number, tree: unknown = {}) =>
    db.prepare(`INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES (?, ?, ?, ?, 1)`).run(
      id,
      sourceId,
      version,
      JSON.stringify(tree),
    );
  const passage = (id: string, sourceId: string, documentId: string, text: string, locator: unknown) =>
    db.prepare(
      `INSERT INTO passages (id, source_id, document_id, text, locator_json, section_path, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, sourceId, documentId, text, JSON.stringify(locator), "2.2 Moto rettilineo");
  db.prepare(`INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('f', ?, 'root', 1)`).run(folder);
  const linked = (sourceId: string, rel: string, missing = false) =>
    db.prepare(
      `INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms, missing_at) VALUES ('f', ?, '', ?, 1, 1, ?)`,
    ).run(rel, sourceId, missing ? 1 : null);
  return { db, workspace, folder, source, document, passage, linked };
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

it("opens a stored PDF at the cited page and reads only the bytes asked for", async () => {
  const t = setup();
  const sha = putBlob(t.workspace, bytes(5000), "application/pdf", "pdf");
  t.source("book", { sha, mime: "application/pdf", title: "Fisica I · Mazzoldi" });
  t.document("book-d1", "book", 1);
  t.passage("p35", "book", "book-d1", "Il percorso inverso richiede un'integrazione.", { page: 35 });
  t.passage("p412", "book", "book-d1", "Ultima pagina letta.", { page: 412 });

  const view = panelSource(t.db, t.workspace, { passageId: "p35" });
  expect(view).toMatchObject({
    sourceId: "book",
    state: "ready",
    original: "stored",
    size: 5000,
    missing: false,
    changed: false,
    pages: 412,
    passage: { id: "p35", page: 35, sectionPath: "2.2 Moto rettilineo" },
  });

  const chunk = await readOriginal(t.db, t.workspace, { sourceId: "book", start: 4000, length: 2000 });
  expect(chunk.size).toBe(5000);
  expect(chunk.bytes.length).toBe(1000);
  expect(chunk.bytes[0]).toBe(4000 % 251);
  // One call never returns more than the chunk cap, whatever the window asks.
  const big = putBlob(t.workspace, bytes(ORIGINAL_CHUNK_MAX + 10), "application/pdf", "pdf");
  t.source("big", { sha: big });
  expect((await readOriginal(t.db, t.workspace, { sourceId: "big", start: 0, length: ORIGINAL_CHUNK_MAX * 4 })).bytes.length).toBe(
    ORIGINAL_CHUNK_MAX,
  );
  expect(fileToOpen(t.db, t.workspace, "book")).toMatchObject({ name: "Fisica I · Mazzoldi.pdf", stored: true });
});

it("reads a linked file in place, and says when it is missing", async () => {
  const t = setup();
  writeFileSync(join(t.folder, "Appunti.pdf"), bytes(300));
  t.source("notes", { title: "Appunti" });
  t.document("notes-d1", "notes", 1);
  t.linked("notes", "Appunti.pdf");
  expect(panelSource(t.db, t.workspace, { sourceId: "notes" })).toMatchObject({ original: "linked", mime: "application/pdf", size: 300, missing: false });
  expect((await readOriginal(t.db, t.workspace, { sourceId: "notes", start: 0, length: 10 })).bytes.length).toBe(10);
  expect(fileToOpen(t.db, t.workspace, "notes")).toEqual({ path: join(t.folder, "Appunti.pdf"), name: "Appunti.pdf", stored: false });

  // Gone from the folder: nothing to read or open, and the panel says so.
  rmSync(join(t.folder, "Appunti.pdf"));
  expect(panelSource(t.db, t.workspace, { sourceId: "notes" })).toMatchObject({ original: null, missing: true });
  await expect(readOriginal(t.db, t.workspace, { sourceId: "notes", start: 0, length: 10 })).rejects.toThrow("source-file-missing");
  expect(fileToOpen(t.db, t.workspace, "notes")).toBeNull();

  // A link put where the file was is not followed.
  writeFileSync(join(t.folder, "..", "outside.pdf"), bytes(20));
  symlinkSync(join(t.folder, "..", "outside.pdf"), join(t.folder, "Appunti.pdf"));
  await expect(readOriginal(t.db, t.workspace, { sourceId: "notes", start: 0, length: 10 })).rejects.toThrow("source-file-missing");

  // A look that marked it missing is enough, even before the panel stats it.
  t.source("lost", { title: "Lavagna" });
  t.linked("lost", "Lavagna.jpg", true);
  expect(panelSource(t.db, t.workspace, { sourceId: "lost" })).toMatchObject({ missing: true, original: null });
});

it("tells reading, locked, removed and failed files apart", () => {
  const t = setup();
  t.source("reading", { status: "extracting" });
  t.source("scan", { status: "ocr-queued" });
  t.source("locked", { status: "failed" });
  t.db.prepare(
    `INSERT INTO jobs (id, kind, params_json, state, error, created_at, updated_at) VALUES ('j', 'source-import', ?, 'failed', 'pdf-password-required', 1, 1)`,
  ).run(JSON.stringify({ sourceId: "locked" }));
  t.source("broken", { status: "failed" });
  t.source("gone", { status: "removed" });
  const state = (id: string) => panelSource(t.db, t.workspace, { sourceId: id })?.state;
  expect([state("reading"), state("scan"), state("locked"), state("broken"), state("gone")]).toEqual([
    "reading",
    "reading",
    "locked",
    "failed",
    "removed",
  ]);
  expect(panelSource(t.db, t.workspace, { sourceId: "locked" })?.errorJobId).toBe("j");
  expect(panelSource(t.db, t.workspace, { sourceId: "nothing" })).toBeNull();
  expect(fileToOpen(t.db, t.workspace, "gone")).toBeNull();
});

it("keeps a citation on the version it came from after the file was replaced", async () => {
  const t = setup();
  const old = putBlob(t.workspace, bytes(100), "application/pdf", "pdf");
  const next = putBlob(t.workspace, bytes(200), "application/pdf", "pdf");
  t.source("book", { sha: next });
  t.document("d1", "book", 1, { blobSha: old });
  t.document("d2", "book", 2);
  t.passage("old-p", "book", "d1", "Una pagina che non c'è più.", { page: 40 });
  t.passage("new-p", "book", "d2", "La stessa sezione, riscritta.", { page: 12 });
  expect(panelSource(t.db, t.workspace, { passageId: "old-p" })).toMatchObject({ changed: true, pages: 40, original: "stored", size: 100 });
  expect(panelSource(t.db, t.workspace, { sourceId: "book" })).toMatchObject({ changed: false, pages: 12, size: 200 });
  expect((await readOriginal(t.db, t.workspace, { passageId: "old-p", start: 0, length: 500 })).size).toBe(100);
});

it("lists the read text of one page or slide in reading order", () => {
  const t = setup();
  t.source("slides", { kind: "pptx" });
  t.document("sd", "slides", 1);
  t.passage("s12a", "slides", "sd", "Area sotto la curva", { slide: 12 });
  t.passage("s12b", "slides", "sd", "Speaker notes: integrale con segno", { slide: 12 });
  t.passage("s13", "slides", "sd", "Moto verticale", { slide: 13 });
  expect(panelPage(t.db, { passageId: "s12b", unit: "slide", n: 12 })).toEqual([
    { id: "s12a", text: "Area sotto la curva", sectionPath: "2.2 Moto rettilineo", current: false },
    { id: "s12b", text: "Speaker notes: integrale con segno", sectionPath: "2.2 Moto rettilineo", current: true },
  ]);
  expect(panelPage(t.db, { sourceId: "slides", unit: "slide", n: 13 }).map((row) => row.id)).toEqual(["s13"]);
  expect(panelPage(t.db, { sourceId: "slides", unit: "slide", n: 99 })).toEqual([]);
});
