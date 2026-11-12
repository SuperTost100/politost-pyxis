import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blobSize, hasBlob } from "../blobs";
import { commitStaged } from "../chat/attach";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { subjectPassages } from "../maps/subject-sources";
import { addSubject } from "../plans/subjects";
import { tempDir } from "../test-temp";
import { extractByExt, extractPlain } from "./documents";
import { enqueueSourceFile, registerSourceJobs, SourceExists, type Extraction } from "./jobs";
import { linkedFolders } from "./linked";
import { moveSource } from "./library-subjects";
import { setChosenKind } from "./manage";
import { hashFiles } from "./quality";
import { listSources } from "./smartbook";

const NOTES = "La velocità è la derivata dello spazio rispetto al tempo. ".repeat(40);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * A workspace with the import jobs and linked folders, and a study folder holding `Fisica/appunti.txt` with `NOTES`.
 * `extract` stands in for the worker's read, so a test can hold one open.
 */
function setup(
  extract?: (input: { path: string; ext: string }) => Promise<Extraction>,
  /** Stands in for the look's hash, so a test can act between the look listing the copies and adopting one. */
  linkHash?: (paths: string[], maxBytes: number) => ReturnType<typeof hashFiles>,
) {
  const db = openDatabase(":memory:");
  const workspace = tempDir("pyxis-adopt-ws-");
  const runner = createRunner(db, () => {});
  const reads: string[] = [];
  registerSourceJobs(
    db,
    workspace,
    runner,
    async (input) => {
      reads.push(input.path);
      return extract
        ? extract(input)
        : { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) };
    },
    { hash: (paths, maxBytes) => hashFiles(paths, maxBytes) },
  );
  const linked = linkedFolders({
    db,
    runner,
    protectedPaths: [workspace],
    hash: linkHash ?? ((paths, maxBytes) => hashFiles(paths, maxBytes)),
    storedSize: (blob) => blobSize(workspace, blob),
    ocrReady: async () => false,
    watch: null,
    pumpMs: 10,
  });
  const root = join(tempDir("pyxis-adopt-folder-"), "Università");
  mkdirSync(join(root, "Fisica"), { recursive: true });
  writeFileSync(join(root, "Fisica", "appunti.txt"), NOTES);
  const outside = (name: string, text = NOTES) => {
    const path = join(tempDir("pyxis-adopt-files-"), name);
    writeFileSync(path, text);
    return path;
  };
  const settled = async () => {
    await linked.idle();
    await expect
      .poll(
        () =>
          db
            .prepare(
              `SELECT (SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running'))
                    + (SELECT COUNT(*) FROM linked_files WHERE pending > 0 AND missing_at IS NULL)`,
            )
            .pluck()
            .get(),
        { timeout: 10_000 },
      )
      .toBe(0);
  };
  /** Links the folder (subjects named from the folder names) and confirms what setup offered. */
  const link = async () => {
    const [folder] = await linked.link({ paths: [root], mode: "root" });
    await linked.confirm({
      folders: [{ folderId: folder!.id, subjects: folder!.subjects.map((s) => ({ key: s.key, name: s.name, skipped: false })) }],
    });
    await settled();
    return folder!;
  };
  const sources = () =>
    db
      .prepare(
        `SELECT s.id, s.status, s.library, s.blob_sha AS blobSha, (SELECT name FROM subjects WHERE id = s.subject_id) AS subject,
           l.rel_path AS rel
         FROM sources s LEFT JOIN linked_files l ON l.source_id = s.id WHERE s.status != 'removed' ORDER BY s.rowid`,
      )
      .all() as Array<{ id: string; status: string; library: number; blobSha: string | null; subject: string | null; rel: string | null }>;
  const passageIds = (id: string) =>
    db.prepare(`SELECT id FROM passages WHERE source_id = ? ORDER BY id`).pluck().all(id) as string[];
  const imports = () => db.prepare(`SELECT COUNT(*) FROM jobs WHERE kind = 'source-import'`).pluck().get() as number;
  return { db, workspace, runner, linked, root, outside, settled, link, sources, passageIds, imports, reads };
}

const rel = join("Fisica", "appunti.txt");

describe("a file imported into the Library before its folder was linked", () => {
  it("is one source: the copy becomes the linked file, keeps its text and takes the folder's subject", async () => {
    const app = setup();
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    const before = app.passageIds(copy.sourceId);
    expect(before.length).toBeGreaterThan(0);

    const folder = await app.link();
    expect(app.sources()).toEqual([
      { id: copy.sourceId, status: "ready", library: 1, blobSha: sha(NOTES), subject: "Fisica", rel },
    ]);
    // Nothing was read again: the copy's passages, which citations point at, are the same rows.
    expect(app.passageIds(copy.sourceId)).toEqual(before);
    expect(app.imports()).toBe(1);
    expect(app.reads.filter((path) => path.startsWith(app.root))).toEqual([]);
    expect(listSources(app.db)).toEqual([
      expect.objectContaining({ id: copy.sourceId, subject: "Fisica", linked: { folderId: folder.id, folder: "Università", missing: false } }),
    ]);
    // Importing the file again, from anywhere, finds that one source.
    await expect(enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("altra copia.txt"))).rejects.toBeInstanceOf(
      SourceExists,
    );
  });

  it("keeps a subject of its own when the folder's is another", async () => {
    const app = setup();
    const own = addSubject(app.db, "Meccanica").id;
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    app.db.prepare(`UPDATE sources SET subject_id = ? WHERE id = ?`).run(own, copy.sourceId);
    await app.settled();
    const folder = await app.link();
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Meccanica", rel })]);
    // Setup again, now that the file has taken the copy over, gives the folder's files their subject but not this one.
    await app.linked.confirm({ folders: [{ folderId: folder.id, subjects: [{ key: "Fisica", name: "Fisica I", skipped: false }] }] });
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Meccanica", rel })]);
  });

  it("takes the folder's subject when setup is confirmed after the file took the copy over", async () => {
    const app = setup();
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    // The look runs before setup is confirmed, so the subfolder has no subject yet and the copy has none either.
    const [folder] = await app.linked.link({ paths: [app.root], mode: "root" });
    await app.settled();
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: null, rel })]);
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [{ key: "Fisica", name: "Fisica", skipped: false }] }] });
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Fisica", rel })]);
  });

  it("follows the folder to another subject when it only had the folder's", async () => {
    const app = setup();
    const analisi = addSubject(app.db, "Analisi").id;
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    const folder = await app.link();
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Fisica", rel })]);
    // The name of an existing subject makes the folder's subject that one, and what the copy took from the folder goes along.
    await app.linked.confirm({ folders: [{ folderId: folder.id, subjects: [{ key: "Fisica", name: "Analisi", skipped: false }] }] });
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Analisi", rel })]);
    expect(app.db.prepare(`SELECT subject_id FROM sources WHERE id = ?`).pluck().get(copy.sourceId)).toBe(analisi);
  });

  it("keeps a subject of its own when the folder is given another subject later", async () => {
    const app = setup();
    const own = addSubject(app.db, "Meccanica").id;
    addSubject(app.db, "Analisi");
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    app.db.prepare(`UPDATE sources SET subject_id = ? WHERE id = ?`).run(own, copy.sourceId);
    await app.settled();
    const folder = await app.link();
    await app.linked.confirm({ folders: [{ folderId: folder.id, subjects: [{ key: "Fisica", name: "Analisi", skipped: false }] }] });
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Meccanica", rel })]);
  });

  it("keeps the subject the student moved it to, even the folder's own, when the folder is given another subject later", async () => {
    const app = setup();
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    const folder = await app.link();
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Fisica", rel })]);
    // Moved by hand into the subject it already had from the folder: from now on that is the student's choice.
    const physics = app.db.prepare(`SELECT subject_id FROM sources WHERE id = ?`).pluck().get(copy.sourceId) as string;
    moveSource(app.db, copy.sourceId, { subjectId: physics });
    addSubject(app.db, "Analisi");
    await app.linked.confirm({ folders: [{ folderId: folder.id, subjects: [{ key: "Fisica", name: "Analisi", skipped: false }] }] });
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, subject: "Fisica", rel, blobSha: sha(NOTES) })]);
  });

  it("is read from the folder once the file there changes, and keeps the original it was imported with", async () => {
    const app = setup();
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    const before = app.passageIds(copy.sourceId);
    const folder = await app.link();

    const changed = `${NOTES}\n\nL'accelerazione è la derivata della velocità.`;
    writeFileSync(join(app.root, rel), changed);
    await app.linked.sync(folder.id);
    await app.settled();
    expect(app.reads).toContain(join(app.root, rel));
    // The new version is the folder's file; the source no longer names the old copy as its current file...
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, status: "ready", blobSha: null, rel })]);
    const versions = app.db
      .prepare(`SELECT version, json_extract(tree_json, '$.blobSha') AS blob FROM source_documents WHERE source_id = ? ORDER BY version`)
      .all(copy.sourceId);
    expect(versions).toEqual([
      { version: 1, blob: sha(NOTES) },
      { version: 2, blob: null },
    ]);
    // ...but the first version keeps it, with the passages cited before.
    expect(hasBlob(app.workspace, sha(NOTES))).toBe(true);
    expect(app.passageIds(copy.sourceId)).toEqual(expect.arrayContaining(before));
    // The hash of the folder's file is what an import compares now.
    await expect(enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("nuova.txt", changed))).rejects.toBeInstanceOf(
      SourceExists,
    );
  });

  it("keeps the kind the student chose for the copy, through the take-over and a read of the changed file", async () => {
    const app = setup();
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    setChosenKind(app.db, copy.sourceId, "exercises");
    const folder = await app.link();
    const kind = () => listSources(app.db).map((source) => [source.id, source.fileKind, source.kindChosen]);
    expect(kind()).toEqual([[copy.sourceId, "exercises", true]]);

    writeFileSync(join(app.root, rel), `${NOTES}\n\nL'accelerazione è la derivata della velocità.`);
    await app.linked.sync(folder.id);
    await app.settled();
    expect(app.reads).toContain(join(app.root, rel));
    expect(kind()).toEqual([[copy.sourceId, "exercises", true]]);
  });

  it("keeps its stored original and its place in the subject when the file goes missing from the folder", async () => {
    const app = setup();
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    const folder = await app.link();
    rmSync(join(app.root, rel));
    await app.linked.sync(folder.id);
    expect(listSources(app.db)).toEqual([
      expect.objectContaining({ id: copy.sourceId, status: "ready", blobSha: sha(NOTES), linked: expect.objectContaining({ missing: true }) }),
    ]);
    expect(hasBlob(app.workspace, sha(NOTES))).toBe(true);
    const subject = app.db.prepare(`SELECT subject_id FROM sources WHERE id = ?`).pluck().get(copy.sourceId) as string;
    // The text came from the copy Pyxis keeps, so the subject's maps still use it.
    expect(subjectPassages(app.db, subject).map((passage) => passage.id)).toEqual(
      expect.arrayContaining([app.passageIds(copy.sourceId)[0]]),
    );
    const again = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt")).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(SourceExists);
    expect((again as SourceExists).sourceId).toBe(copy.sourceId);
  });

  it("takes over a copy still being read, which finishes from its stored original", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const app = setup(async (input) => {
      if (!input.path.startsWith(app.root)) await held;
      return { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) };
    });
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await expect.poll(() => app.sources()[0]?.status).toBe("extracting");
    const [folder] = await app.linked.link({ paths: [app.root], mode: "root" });
    await app.linked.idle();
    expect(app.sources()).toEqual([expect.objectContaining({ id: copy.sourceId, status: "extracting", rel })]);
    release();
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [{ key: "Fisica", name: "Fisica", skipped: false }] }] });
    await app.settled();
    expect(app.sources()).toEqual([
      expect.objectContaining({ id: copy.sourceId, status: "ready", blobSha: sha(NOTES), subject: "Fisica", rel }),
    ]);
    expect(app.passageIds(copy.sourceId).length).toBeGreaterThan(0);
    expect(app.reads.filter((path) => path.startsWith(app.root))).toEqual([]);
  });

  const OTHER = "L'integrale è l'area sotto la curva. ".repeat(40);
  const textOf = (app: ReturnType<typeof setup>, id: string) =>
    app.db.prepare(`SELECT text FROM passages WHERE source_id = ?`).pluck().all(id).join("");
  /** An `extract` that waits on its second read of a stored file, which is the replacement's. */
  function holdSecondRead() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const extract = async (input: { path: string; ext: string }): Promise<Extraction> => {
      if (!input.path.includes("pyxis-adopt-folder-") && ++reads === 2) await held;
      return { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) };
    };
    return { extract, release };
  }

  it("does not take over a copy that is being replaced with another file: the folder's file is its own source", async () => {
    const { extract, release } = holdSecondRead();
    const app = setup(extract);
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("nuovo.txt", OTHER), copy.sourceId);
    await expect.poll(() => app.sources()[0]?.status).toBe("extracting");
    // Until the replacement is published the copy still names the old file, whose bytes the folder's file has.
    expect(app.sources()[0]!.blobSha).toBe(sha(NOTES));
    const [folder] = await app.linked.link({ paths: [app.root], mode: "root" });
    await app.linked.idle();
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [{ key: "Fisica", name: "Fisica", skipped: false }] }] });
    release();
    await app.settled();
    const rows = app.sources();
    expect(rows).toHaveLength(2);
    const replaced = rows.find((row) => row.id === copy.sourceId)!;
    const file = rows.find((row) => row.rel === rel)!;
    expect(replaced).toMatchObject({ status: "ready", rel: null, blobSha: sha(OTHER) });
    expect(file).toMatchObject({ id: expect.not.stringMatching(copy.sourceId), status: "ready", blobSha: null });
    expect(textOf(app, copy.sourceId)).toContain("integrale");
    expect(textOf(app, file.id)).toContain("velocità");
  });

  it("does not take over a copy whose replacement starts after the look listed it", async () => {
    const { extract, release } = holdSecondRead();
    let replaceNow: (() => Promise<unknown>) | undefined;
    const app = setup(extract, async (paths, maxBytes) => {
      const hashes = await hashFiles(paths, maxBytes);
      await replaceNow?.();
      replaceNow = undefined;
      return hashes;
    });
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    // The replacement is queued between the look's hash and its takeover, so only the check at that moment can see it.
    replaceNow = () => enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("nuovo.txt", OTHER), copy.sourceId);
    const [folder] = await app.linked.link({ paths: [app.root], mode: "root" });
    await app.linked.idle();
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [{ key: "Fisica", name: "Fisica", skipped: false }] }] });
    release();
    await app.settled();
    const rows = app.sources();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === copy.sourceId)).toMatchObject({ rel: null, blobSha: sha(OTHER) });
    expect(textOf(app, rows.find((row) => row.rel === rel)!.id)).toContain("velocità");
  });

  it("of two copies with the same bytes, the newest becomes the linked file and the other stays a copy", async () => {
    const app = setup();
    const older = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    // Two copies of one file, as a Library from before imports were checked for duplicates may hold.
    app.db.prepare(`UPDATE sources SET blob_sha = NULL WHERE id = ?`).run(older.sourceId);
    const newer = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("copia.txt"));
    app.db.prepare(`UPDATE sources SET blob_sha = ? WHERE id = ?`).run(sha(NOTES), older.sourceId);
    await app.settled();
    await app.link();
    expect(app.sources()).toEqual([
      expect.objectContaining({ id: older.sourceId, rel: null }),
      expect.objectContaining({ id: newer.sourceId, rel }),
    ]);
  });

  it("does not take over a copy a chat keeps, or one whose import failed: the file is read as its own source", async () => {
    const app = setup();
    app.db.prepare(`INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES ('c', 't', '[]', 1, 1)`).run();
    const {
      sourceIds: [hidden],
    } = commitStaged(
      app.db,
      app.workspace,
      {
        blobs: [],
        documents: [
          { filePath: "/x/appunti.txt", ext: ".txt", bytes: new TextEncoder().encode(NOTES), extracted: extractPlain(NOTES, false) },
        ],
      },
      (ids) => app.db.prepare(`UPDATE chats SET scope_json = ? WHERE id = 'c'`).run(JSON.stringify(ids)),
    );
    const failed = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    app.db.prepare(`UPDATE sources SET status = 'failed' WHERE id = ?`).run(failed.sourceId);
    await app.link();
    const rows = app.sources();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === hidden)).toMatchObject({ library: 0, rel: null });
    expect(rows.find((row) => row.id === failed.sourceId)).toMatchObject({ status: "failed", rel: null });
    expect(rows.find((row) => row.rel === rel)).toMatchObject({ status: "ready", library: 1, blobSha: null, subject: "Fisica" });
    expect(app.reads).toContain(join(app.root, rel));
  });

  it("is taken over by one file only, when the folder holds the same file twice", async () => {
    const app = setup();
    writeFileSync(join(app.root, "Fisica", "appunti (1).txt"), NOTES);
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, app.outside("appunti.txt"));
    await app.settled();
    await app.link();
    const rows = app.sources();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.id === copy.sourceId)).toHaveLength(1);
    expect(rows.every((row) => row.rel !== null)).toBe(true);
  });
});
