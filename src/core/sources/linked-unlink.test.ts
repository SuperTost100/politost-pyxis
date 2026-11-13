import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { blobSize } from "../blobs";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { tempDir } from "../test-temp";
import { extractByExt } from "./documents";
import { enqueueSourceFile, markStoppedImport, registerSourceJobs } from "./jobs";
import { linkedFolders } from "./linked";
import { moveSource } from "./library-subjects";
import { hashFiles } from "./quality";
import { retrieve } from "./retrieve";
import { listSources } from "./smartbook";

const NOTES = "Il campo elettrico di una carica puntiforme decresce con il quadrato della distanza. ".repeat(30);

/** A study folder with two subjects, and the import jobs and linked folders over an in-memory workspace. */
function setup(options: { paused?: boolean; failOn?: string } = {}) {
  const db = openDatabase(":memory:");
  const workspace = tempDir("pyxis-unlink-ws-");
  const updates: Array<{ id: string; kind: string; state: string }> = [];
  const runner = createRunner(
    db,
    (job) => {
      updates.push(job);
      // As core wires it: a source whose import stopped shows that state.
      markStoppedImport(db, job);
    },
    undefined,
    options.paused === true,
  );
  registerSourceJobs(
    db,
    workspace,
    runner,
    async (input) => {
      // A file whose reading fails, as a damaged one does.
      if (options.failOn && input.path.includes(options.failOn)) throw new Error("unreadable");
      return { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) };
    },
    { hash: (paths, maxBytes) => hashFiles(paths, maxBytes) },
  );
  let changes = 0;
  const linked = linkedFolders({
    db,
    runner,
    protectedPaths: [workspace],
    hash: (paths, maxBytes) => hashFiles(paths, maxBytes),
    storedSize: (sha) => blobSize(workspace, sha),
    ocrReady: async () => false,
    watch: null,
    pumpMs: 10,
    listAfterMs: 0,
    onChange: () => {
      changes += 1;
    },
  });
  const root = join(tempDir("pyxis-unlink-folder-"), "Polito");
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("Fisica/appunti.txt", NOTES);
  put("Fisica/lezione 1.txt", "La legge di Gauss lega il flusso del campo alla carica racchiusa.");
  put("GAL/matrici.txt", "Una matrice quadrata è invertibile se il determinante non è nullo.");
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
  const link = async (path = root) => {
    const [folder] = await linked.link({ paths: [path], mode: "root" });
    await linked.confirm({
      folders: [{ folderId: folder!.id, subjects: folder!.subjects.map((s) => ({ key: s.key, name: s.name, skipped: false })) }],
    });
    return folder!;
  };
  const count = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number;
  const sourceId = (title: string) =>
    db.prepare(`SELECT id FROM sources WHERE title = ? ORDER BY rowid DESC`).pluck().get(title) as string;
  const library = () =>
    listSources(db)
      .map((source) => source.title)
      .sort();
  return { db, workspace, runner, linked, root, put, settled, link, count, sourceId, library, updates, changes: () => changes };
}

/** Every entry under `root` with its type, size and modification time, to show nothing was written there. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = statSync(full);
      out.push(`${relative(root, full)} ${info.isDirectory() ? "d" : "f"} ${info.size} ${info.mtimeMs}`);
      if (info.isDirectory()) walk(full);
    }
  };
  walk(root);
  out.push(`. ${statSync(root).mtimeMs}`);
  return out;
}

describe("unlinking a folder", () => {
  it("takes its files out of the Library, every exam and retrieval, keeps what cites them, and touches nothing on disk", async () => {
    const app = setup();
    const folder = await app.link();
    await app.settled();
    const before = snapshot(app.root);
    expect(app.library()).toEqual(["appunti", "lezione 1", "matrici"]);
    const appunti = app.sourceId("appunti");
    const passage = app.db.prepare(`SELECT id FROM passages WHERE source_id = ?`).pluck().get(appunti) as string;
    const passages = app.count(`SELECT COUNT(*) FROM passages`);
    // An exam studies from the file, a flashcard and an answer cite it, and a map names it.
    app.db.prepare(`INSERT INTO plans (id, title, created_at, updated_at) VALUES ('p', 'Fisica', 1, 1)`).run();
    app.db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES ('p', ?)`).run(appunti);
    app.db.prepare(`INSERT INTO cards (id, plan_id, front, back, passage_id, created_at) VALUES ('k', 'p', 'f', 'b', ?, 1)`).run(passage);
    app.db.prepare(`INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 'Gauss', 1, 1)`).run();
    app.db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'assistant', 'b', 1)`).run();
    app.db.prepare(`INSERT INTO message_passages (message_id, passage_id, label) VALUES ('m', ?, 'P1')`).run(passage);
    expect(retrieve(app.db, "campo elettrico carica puntiforme").hits.map((hit) => hit.sourceId)).toContain(appunti);
    const subjects = app.count(`SELECT COUNT(*) FROM subjects`);
    const told = app.changes();

    expect(app.linked.unlink(folder.id)).toEqual({ removed: 3, kept: 0 });

    expect(app.library()).toEqual([]);
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE status = 'removed'`)).toBe(3);
    expect(app.count(`SELECT COUNT(*) FROM plan_sources`)).toBe(0);
    expect(retrieve(app.db, "campo elettrico carica puntiforme").hits).toEqual([]);
    // The citations keep their text, and what was made from the files stays.
    expect(app.count(`SELECT COUNT(*) FROM passages`)).toBe(passages);
    expect(app.count(`SELECT COUNT(*) FROM cards WHERE id = 'k'`)).toBe(1);
    expect(app.count(`SELECT COUNT(*) FROM message_passages WHERE message_id = 'm'`)).toBe(1);
    // The folder and its rows go; the subjects it named stay, empty, for the student to keep or delete.
    expect(app.linked.list()).toEqual([]);
    expect(app.count(`SELECT COUNT(*) FROM linked_files`)).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM linked_subfolders`)).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM subjects`)).toBe(subjects);
    expect(app.changes()).toBe(told + 1);
    expect(snapshot(app.root)).toEqual(before);
    expect(() => app.linked.unlink(folder.id)).toThrow("linked-folder-missing");
  });

  it("is one transaction: when it fails, nothing of it is done", async () => {
    const app = setup();
    const folder = await app.link();
    await app.settled();
    app.db.exec(`CREATE TRIGGER refuse BEFORE DELETE ON linked_folders BEGIN SELECT RAISE(ABORT, 'disk-full'); END`);
    expect(() => app.linked.unlink(folder.id)).toThrow("disk-full");
    expect(app.library()).toEqual(["appunti", "lezione 1", "matrici"]);
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE status = 'removed'`)).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM linked_files`)).toBe(3);
    expect(app.linked.list()).toHaveLength(1);
  });

  it("keeps in the Library a copy imported before the folder took it over, and linking again takes it over once more", async () => {
    const app = setup();
    const outside = join(tempDir("pyxis-unlink-files-"), "appunti.txt");
    writeFileSync(outside, NOTES);
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, outside);
    await app.settled();
    const folder = await app.link();
    await app.settled();
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE source_id = ?`, copy.sourceId)).toBe(1);

    expect(app.linked.unlink(folder.id)).toEqual({ removed: 2, kept: 1 });
    expect(app.library()).toEqual(["appunti"]);
    const kept = app.db.prepare(`SELECT status, library, blob_sha AS sha FROM sources WHERE id = ?`).get(copy.sourceId);
    expect(kept).toMatchObject({ status: "ready", library: 1 });
    expect((kept as { sha: string | null }).sha).not.toBeNull();

    // Linked again: the folder reads as new, the copy is taken over again, and nothing shows twice.
    await app.link();
    await app.settled();
    expect(app.library()).toEqual(["appunti", "lezione 1", "matrici"]);
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE source_id = ?`, copy.sourceId)).toBe(1);
  });

  it("takes out a copy whose file changed in the folder, since its text is the folder's now", async () => {
    const app = setup();
    const outside = join(tempDir("pyxis-unlink-files-"), "appunti.txt");
    writeFileSync(outside, NOTES);
    const copy = await enqueueSourceFile(app.db, app.workspace, app.runner, outside);
    await app.settled();
    const folder = await app.link();
    await app.settled();
    const later = new Date(Date.now() + 60_000);
    writeFileSync(join(app.root, "Fisica", "appunti.txt"), "Il potenziale elettrico è il lavoro per unità di carica.");
    utimesSync(join(app.root, "Fisica", "appunti.txt"), later, later);
    await app.linked.sync(folder.id);
    await app.settled();
    expect(app.db.prepare(`SELECT blob_sha FROM sources WHERE id = ?`).pluck().get(copy.sourceId)).toBeNull();

    expect(app.linked.unlink(folder.id)).toEqual({ removed: 3, kept: 0 });
    expect(app.library()).toEqual([]);
  });

  it("reads the folder as new when it is linked again, without the subject chosen by hand before", async () => {
    const app = setup();
    const folder = await app.link();
    await app.settled();
    const gal = app.db.prepare(`SELECT id FROM subjects WHERE name = 'GAL'`).pluck().get() as string;
    moveSource(app.db, app.sourceId("lezione 1"), { subjectId: gal });
    app.linked.unlink(folder.id);

    await app.link();
    await app.settled();
    expect(app.library()).toEqual(["appunti", "lezione 1", "matrici"]);
    expect(app.count(`SELECT COUNT(*) FROM sources`)).toBe(6);
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE status = 'removed'`)).toBe(3);
    const subject = app.db
      .prepare(`SELECT sub.name FROM sources s JOIN subjects sub ON sub.id = s.subject_id WHERE s.id = ?`)
      .pluck()
      .get(app.sourceId("lezione 1"));
    expect(subject).toBe("Fisica");
    // The subjects are the ones that stayed, not new ones with the same names.
    expect(app.count(`SELECT COUNT(*) FROM subjects`)).toBe(2);
  });

  it("stops the folder's reading in progress, and leaves nothing running or offered in Attività", async () => {
    // Imports wait in the queue, as when the folder is still being read.
    const app = setup({ paused: true });
    const folder = await app.link();
    await app.linked.idle();
    await expect
      .poll(() => app.count(`SELECT COUNT(*) FROM jobs WHERE kind = 'source-import' AND state = 'queued'`))
      .toBe(3);
    expect(app.linked.view(folder.id).state).toBe("reading");

    app.linked.unlink(folder.id);
    expect(
      app.count(`SELECT COUNT(*) FROM jobs WHERE kind = 'source-import' AND (state IN ('queued', 'running') OR dismissed = 0)`),
    ).toBe(0);
    expect(app.runner.list().filter((job) => job.kind.startsWith("source-") || job.kind.startsWith("linked-"))).toEqual([]);
  });

  it("drops the folder's failed readings from Attività, so nothing offers to retry a file that left", async () => {
    const app = setup({ failOn: "matrici" });
    const folder = await app.link();
    await app.settled();
    expect(app.runner.list().filter((job) => job.state === "failed")).toHaveLength(1);

    app.linked.unlink(folder.id);
    expect(app.runner.list().filter((job) => job.kind.startsWith("source-"))).toEqual([]);
    expect(app.count(`SELECT COUNT(*) FROM jobs WHERE kind = 'source-import' AND state = 'failed' AND dismissed = 0`)).toBe(0);
  });

  it("stops a look that is walking the folder, which then writes nothing", async () => {
    const app = setup();
    for (let index = 0; index < 400; index += 1) app.put(`Fisica/cap ${index % 20}/nota ${index}.txt`, `Nota ${index}`);
    const folder = await app.link();
    await app.linked.idle();
    // A whole look again, unlinked as soon as it starts.
    const look = app.linked.sync(folder.id);
    app.linked.unlink(folder.id);
    await look;
    await app.linked.idle();
    expect(app.count(`SELECT COUNT(*) FROM linked_files`)).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM linked_folders`)).toBe(0);
    await expect.poll(() => app.count(`SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running')`)).toBe(0);
    expect(app.library()).toEqual([]);
  });
});

describe("a linked folder in the list", () => {
  it("says how many files Pyxis reads there, how many are read and when it last looked", async () => {
    const app = setup();
    const folder = await app.link();
    await app.settled();
    const view = app.linked.view(folder.id);
    expect(view).toMatchObject({ files: 3, read: 3, state: "ready" });
    expect(view.checkedAt).toEqual(expect.any(Number));
  });

  it("does not count a file whose reading failed as read, and says how many could not be read", async () => {
    const app = setup({ failOn: "matrici" });
    const folder = await app.link();
    await app.settled();
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE status = 'failed'`)).toBe(1);
    expect(app.linked.view(folder.id)).toMatchObject({ files: 3, read: 2, failed: 1, state: "ready" });
  });

  it("reads one folder again now, and leaves the others alone", async () => {
    const app = setup();
    const folder = await app.link();
    const other = join(tempDir("pyxis-unlink-other-"), "Altro");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "note.txt"), "Note di un altro corso.");
    const [second] = await app.linked.link({ paths: [other], mode: "subject" });
    await app.settled();
    const otherCheck = app.linked.view(second!.id).checkedAt;
    writeFileSync(join(app.root, "GAL", "vettori.txt"), "Due vettori sono ortogonali se il prodotto scalare è nullo.");
    app.linked.reread(folder.id);
    await app.settled();
    expect(app.library()).toContain("vettori");
    expect(app.linked.view(second!.id).checkedAt).toBe(otherCheck);
    expect(() => app.linked.reread("nope")).toThrow("linked-folder-missing");
  });

  it("says a folder is missing, finds it again where the student points when its files are there, and refuses another", async () => {
    const app = setup();
    const folder = await app.link();
    await app.settled();
    const ids = app.db.prepare(`SELECT source_id FROM linked_files ORDER BY rel_path`).pluck().all();
    const moved = join(tempDir("pyxis-unlink-moved-"), "Polito 2026");
    renameSync(app.root, moved);
    await app.linked.sync(folder.id);
    expect(app.linked.view(folder.id).state).toBe("missing");
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE missing_at IS NOT NULL`)).toBe(3);

    // Another folder with none of its files: nothing changes.
    const elsewhere = join(tempDir("pyxis-unlink-else-"), "Vacanze");
    mkdirSync(join(elsewhere, "Fisica"), { recursive: true });
    writeFileSync(join(elsewhere, "Fisica", "appunti.txt"), "Altro testo.");
    expect(await app.linked.relocate(folder.id, elsewhere)).toEqual({ same: false, matched: 0, total: 3 });
    expect(app.linked.view(folder.id).path).toBe(app.root);

    // The folder where it went: the same folder, with the same sources, no longer missing.
    expect(await app.linked.relocate(folder.id, moved)).toEqual({ same: true, matched: 3, total: 3 });
    await app.settled();
    expect(app.linked.view(folder.id)).toMatchObject({ path: moved, state: "ready", files: 3 });
    expect(app.db.prepare(`SELECT source_id FROM linked_files ORDER BY rel_path`).pluck().all()).toEqual(ids);
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE missing_at IS NOT NULL`)).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM sources`)).toBe(3);
  });

  it("does not take a folder for the same one when the matching files are links the folder's reading skips", async () => {
    const app = setup();
    const folder = await app.link();
    await app.settled();
    const base = tempDir("pyxis-unlink-links-");
    const real = join(base, "real");
    renameSync(app.root, real);
    await app.linked.sync(folder.id);
    // One real file, one file that is a link to a file of the same size, and a subject folder that is a link.
    const candidate = join(base, "Polito");
    mkdirSync(join(candidate, "Fisica"), { recursive: true });
    copyFileSync(join(real, "Fisica", "appunti.txt"), join(candidate, "Fisica", "appunti.txt"));
    symlinkSync(join(real, "Fisica", "lezione 1.txt"), join(candidate, "Fisica", "lezione 1.txt"));
    // A junction needs no privilege on Windows; elsewhere it is a plain link to a folder.
    symlinkSync(join(real, "GAL"), join(candidate, "GAL"), "junction");

    expect(await app.linked.relocate(folder.id, candidate)).toEqual({ same: false, matched: 1, total: 3 });
    expect(app.linked.view(folder.id).path).toBe(app.root);
    // The same files as plain files are the same folder.
    const plain = join(base, "Polito copia");
    mkdirSync(join(plain, "GAL"), { recursive: true });
    mkdirSync(join(plain, "Fisica"), { recursive: true });
    for (const rel of ["Fisica/appunti.txt", "Fisica/lezione 1.txt", "GAL/matrici.txt"])
      copyFileSync(join(real, rel), join(plain, rel));
    expect(await app.linked.relocate(folder.id, plain)).toEqual({ same: true, matched: 3, total: 3 });
    // Pointing the folder at `plain` starts a look there. It holds `plain` open while it walks, and Windows refuses to
    // delete a folder that is open, so the test waits for it before its folders are removed.
    await app.settled();
    expect(app.linked.view(folder.id)).toMatchObject({ path: plain, state: "ready", files: 3 });
  });

  it("refuses to find a folder at a place inside another linked folder", async () => {
    const app = setup();
    const folder = await app.link();
    const other = join(tempDir("pyxis-unlink-other-"), "Altro");
    mkdirSync(join(other, "Dentro"), { recursive: true });
    await app.linked.link({ paths: [other], mode: "subject" });
    await app.settled();
    await expect(app.linked.relocate(folder.id, join(other, "Dentro"))).rejects.toThrow("folder-overlap");
  });
});
