import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { createRunner } from "../jobs/runner";
import { tempDir } from "../test-temp";
import { extractByExt } from "./documents";
import { MAX_FOLDER_DEPTH } from "./folder";
import { registerSourceJobs } from "./jobs";
import { checkLinkPath, linkedFolders, readFolder, subjectCandidates } from "./linked";
import { hashFiles } from "./quality";
import { listSources } from "./smartbook";
import { waitingScans } from "./ocr-job";
import { linkedFile, readableLinkedPath } from "./linked-file";

type Run = NonNullable<GenerateInput["run"]>;

/** A student's study folder: three subjects, a folder of holiday paperwork, and notes at the top. */
function studyTree() {
  const root = join(tempDir("pyxis-linked-"), "Università");
  const file = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  file("Fisica 1/Mazzoldi cap 2.md", "# Cinematica\n\nLa velocità è la derivata della posizione rispetto al tempo.");
  file("Fisica 1/Temi d'esame/febbraio.txt", "Esercizio 1. Un punto si muove con velocità costante.");
  file("GAL/appunti.txt", "Una matrice è invertibile se il determinante non è nullo.");
  file("Erasmus/learning agreement.txt", "Learning agreement for the exchange semester.");
  file("orario.txt", "Lunedì: Fisica, martedì: GAL.");
  return root;
}

const answer = (folders: unknown[]): Run => async () => ({
  text: "",
  provider: "claude",
  model: "claude-sonnet-5",
  inputTokens: 1,
  structured: { folders },
});

const tidy = answer([
  { folder: "Fisica 1", subject: "Fisica I", study: true, kinds: ["book", "exams"] },
  { folder: "GAL", subject: "Geometria e algebra lineare", study: true, kinds: ["notes"] },
  { folder: "Erasmus", subject: "Erasmus", study: false, kinds: [] },
]);

function setup(
  options: {
    run?: Run;
    engine?: boolean;
    watch?: Parameters<typeof linkedFolders>[0]["watch"];
    hash?: Parameters<typeof linkedFolders>[0]["hash"];
  } = {},
) {
  const changes = { count: 0 };
  const db = openDatabase(":memory:");
  if (options.engine !== false)
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
  const workspace = tempDir("pyxis-linked-ws-");
  const runner = createRunner(db, () => {});
  const reads: string[] = [];
  registerSourceJobs(
    db,
    workspace,
    runner,
    async (input) => {
      reads.push(input.path);
      const { readFileSync } = await import("node:fs");
      return { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) };
    },
    { hash: (paths, maxBytes) => hashFiles(paths, maxBytes) },
  );
  const linked = linkedFolders({
    db,
    runner,
    protectedPaths: [workspace],
    hash: options.hash ?? ((paths, maxBytes) => hashFiles(paths, maxBytes)),
    ocrReady: async () => false,
    run: options.run ?? tidy,
    watch: options.watch ?? null,
    onChange: () => {
      changes.count += 1;
    },
  });
  const settled = () =>
    expect
      .poll(() => db.prepare(`SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running')`).pluck().get(), {
        timeout: 10_000,
      })
      .toBe(0);
  const source = (title: string) =>
    db
      .prepare(
        `SELECT s.id, s.status, s.blob_sha AS blobSha, s.subject_id AS subjectId, l.rel_path AS rel, l.missing_at AS missingAt
         FROM sources s JOIN linked_files l ON l.source_id = s.id WHERE s.title = ?`,
      )
      .get(title) as
      | { id: string; status: string; blobSha: string | null; subjectId: string | null; rel: string; missingAt: number | null }
      | undefined;
  const subjectName = (id: string | null) =>
    id ? (db.prepare(`SELECT name FROM subjects WHERE id = ?`).pluck().get(id) as string) : null;
  return { db, workspace, runner, linked, settled, source, subjectName, reads, changes };
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

describe("reading a linked folder", () => {
  it("groups files by first-level subfolder, keeps top-level files without a subject and skips book packages", () => {
    const root = studyTree();
    writeFileSync(join(root, "GAL", "libro.ptsb"), "x");
    const { found, cut } = readFolder(root, "root", []);
    expect(found.map((file) => [file.rel, file.subfolder])).toEqual([
      [join("Erasmus", "learning agreement.txt"), "Erasmus"],
      [join("Fisica 1", "Mazzoldi cap 2.md"), "Fisica 1"],
      [join("Fisica 1", "Temi d'esame", "febbraio.txt"), "Fisica 1"],
      [join("GAL", "appunti.txt"), "GAL"],
      ["orario.txt", ""],
    ]);
    expect(cut).toEqual({ files: false, depth: false, entries: false, unreadable: false });
    expect([...subjectCandidates(root, "root", found).keys()]).toEqual(["Erasmus", "Fisica 1", "GAL"]);
    // One folder per subject: everything in it belongs to the folder itself.
    const fisica = join(root, "Fisica 1");
    const own = readFolder(fisica, "subject", []);
    expect(own.found.every((file) => file.subfolder === "")).toBe(true);
    expect([...subjectCandidates(fisica, "subject", own.found).entries()]).toEqual([
      ["", { folder: "Fisica 1", files: ["Mazzoldi cap 2.md", join("Temi d'esame", "febbraio.txt")] }],
    ]);
    // A study folder with no subfolders is one subject.
    expect([...subjectCandidates(join(root, "GAL"), "root", readFolder(join(root, "GAL"), "root", []).found).keys()]).toEqual([""]);
  });

  it("reports a walk the caps cut, and never walks into an excluded folder", () => {
    const root = studyTree();
    let deep = join(root, "Fisica 1");
    for (let level = 0; level <= MAX_FOLDER_DEPTH; level += 1) deep = join(deep, `l${level}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "lost.txt"), "x");
    expect(readFolder(root, "root", []).cut.depth).toBe(true);
    const excluded = readFolder(root, "root", [join(root, "Erasmus")]);
    expect(excluded.found.some((file) => file.subfolder === "Erasmus")).toBe(false);
  });

  it("accepts only an absolute directory outside the workspace and the app's data", () => {
    const root = studyTree();
    const workspace = tempDir("pyxis-linked-ws-");
    mkdirSync(join(workspace, "blobs"));
    expect(checkLinkPath(root, [workspace])).toBe(realpathSync.native(root));
    // Resolve aliases on every platform, including macOS /var and Windows short temp paths.
    const alias = join(tempDir("pyxis-linked-alias-"), "study");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(checkLinkPath(alias, [workspace])).toBe(realpathSync.native(root));
    expect(() => checkLinkPath("Università", [workspace])).toThrow("folder-missing");
    expect(() => checkLinkPath(join(root, "orario.txt"), [workspace])).toThrow("folder-missing");
    expect(() => checkLinkPath(join(root, "nowhere"), [workspace])).toThrow("folder-missing");
    expect(() => checkLinkPath(workspace, [workspace])).toThrow("folder-inside-data");
    expect(() => checkLinkPath(join(workspace, "blobs"), [workspace])).toThrow("folder-inside-data");
    // A link that leads into the workspace is judged by where it leads.
    symlinkSync(join(workspace, "blobs"), join(root, "shortcut"));
    expect(() => checkLinkPath(join(root, "shortcut"), [workspace])).toThrow("folder-inside-data");
  });
});

describe("linked folders", () => {
  it("names the subjects, reads every subject folder in place and leaves the skipped one unread", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    expect(folder).toMatchObject({ name: "Università", mode: "root", detection: "ai" });
    expect(folder!.subjects).toEqual([
      { key: "Fisica 1", folder: "Fisica 1", name: "Fisica I", kinds: ["book", "exams"], skipped: false },
      { key: "GAL", folder: "GAL", name: "Geometria e algebra lineare", kinds: ["notes"], skipped: false },
      { key: "Erasmus", folder: "Erasmus", name: "Erasmus", kinds: [], skipped: true },
    ]);
    await app.settled();
    const mazzoldi = app.source("Mazzoldi cap 2")!;
    expect(mazzoldi).toMatchObject({ status: "ready", blobSha: null, missingAt: null });
    expect(app.source("orario")).toMatchObject({ status: "ready", subjectId: null });
    expect(app.source("learning agreement")).toBeUndefined();
    // Read from the student's folder, not from a copy.
    expect(app.reads).toContain(join(root, "Fisica 1", "Mazzoldi cap 2.md"));
    expect(app.db.prepare(`SELECT COUNT(*) FROM passages WHERE source_id = ?`).pluck().get(mazzoldi.id)).toBeGreaterThan(0);
    // No original was stored: the document names no copy of the file.
    const stored = app.db.prepare(`SELECT tree_json FROM source_documents WHERE source_id = ?`).pluck().get(mazzoldi.id) as string;
    expect(JSON.parse(stored)).not.toHaveProperty("blobSha");

    // The student fixes a name and says Erasmus is a subject after all.
    const confirmed = await app.linked.confirm({
      folders: [
        {
          folderId: folder!.id,
          subjects: [
            { key: "Fisica 1", name: "Fisica", skipped: false },
            { key: "GAL", name: "Geometria e algebra lineare", skipped: false },
            { key: "Erasmus", name: "Erasmus", skipped: false },
          ],
        },
      ],
    });
    expect(confirmed.subjects.map((subject) => subject.name).sort()).toEqual([
      "Erasmus",
      "Fisica",
      "Geometria e algebra lineare",
    ]);
    await app.settled();
    expect(app.subjectName(app.source("Mazzoldi cap 2")!.subjectId)).toBe("Fisica");
    expect(app.subjectName(app.source("febbraio")!.subjectId)).toBe("Fisica");
    expect(app.subjectName(app.source("appunti")!.subjectId)).toBe("Geometria e algebra lineare");
    expect(app.subjectName(app.source("learning agreement")!.subjectId)).toBe("Erasmus");
    // The Library shows them with their subject and folder.
    const listed = listSources(app.db).find((source) => source.title === "appunti")!;
    expect(listed).toMatchObject({
      subject: "Geometria e algebra lineare",
      linked: { folderId: folder!.id, folder: "Università", missing: false },
    });
    // An existing subject is reused, not made twice.
    expect(app.db.prepare(`SELECT COUNT(*) FROM subjects`).pluck().get()).toBe(3);
  });

  it("uses the folder names and skips nothing without an AI tool", async () => {
    const root = studyTree();
    const app = setup({ engine: false });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    expect(folder!.detection).toBe("names");
    expect(folder!.subjects.map((subject) => [subject.name, subject.skipped])).toEqual([
      ["Erasmus", false],
      ["Fisica 1", false],
      ["GAL", false],
    ]);
    await app.settled();
    expect(app.source("learning agreement")).toMatchObject({ status: "ready" });
  });

  it("links each folder as one subject in the per-subject mode, with one model call for all of them", async () => {
    const root = studyTree();
    let calls = 0;
    const app = setup({
      run: async (input) => {
        calls += 1;
        return answer([
          { folder: "Fisica 1", subject: "Fisica I", study: true, kinds: [] },
          { folder: "GAL", subject: "Geometria e algebra lineare", study: false, kinds: [] },
        ])(input);
      },
    });
    const folders = await app.linked.link({ paths: [join(root, "Fisica 1"), join(root, "GAL")], mode: "subject" });
    expect(calls).toBe(1);
    expect(folders.map((folder) => folder.subjects)).toEqual([
      [{ key: "", folder: "Fisica 1", name: "Fisica I", kinds: [], skipped: false }],
      [{ key: "", folder: "GAL", name: "Geometria e algebra lineare", kinds: [], skipped: false }],
    ]);
    await app.settled();
    // A file in a subfolder of a subject folder belongs to that subject, not to a new one.
    expect(app.source("febbraio")).toBeDefined();
    expect(app.db.prepare(`SELECT COUNT(*) FROM linked_subfolders`).pluck().get()).toBe(2);
    // Linking a folder inside one already linked, or around it, is refused.
    await expect(app.linked.link({ paths: [join(root, "Fisica 1", "Temi d'esame")], mode: "subject" })).rejects.toThrow(
      "folder-overlap",
    );
    await expect(app.linked.link({ paths: [root], mode: "root" })).rejects.toThrow("folder-overlap");
    // The same folder again is the folder already linked.
    const again = await app.linked.link({ paths: [join(root, "GAL")], mode: "subject" });
    expect(again[0]!.id).toBe(folders[1]!.id);
  });

  it("marks deleted files missing and keeps their text, follows moved files and reads changed ones again", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
    await app.settled();
    const appunti = app.source("appunti")!;
    const passages = () => app.db.prepare(`SELECT COUNT(*) FROM passages WHERE source_id = ?`).pluck().get(appunti.id);
    const before = passages();

    // Deleted while Pyxis was closed: the next look marks it, and nothing of it is removed.
    const told = app.changes.count;
    rmSync(join(root, "GAL", "appunti.txt"));
    await app.linked.sync(folder!.id);
    expect(app.source("appunti")!.missingAt).not.toBeNull();
    // No job announces it, so the look tells the window itself, and only when something changed.
    expect(app.changes.count).toBe(told + 1);
    await app.linked.sync(folder!.id);
    expect(app.changes.count).toBe(told + 1);
    expect(passages()).toBe(before);
    expect(listSources(app.db).find((source) => source.id === appunti.id)!.linked).toMatchObject({ missing: true });

    // Back where it was with the same contents: no longer missing, and not read again.
    writeFileSync(join(root, "GAL", "appunti.txt"), "Una matrice è invertibile se il determinante non è nullo.");
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(app.source("appunti")!.missingAt).toBeNull();
    expect(app.db.prepare(`SELECT COUNT(*) FROM source_documents WHERE source_id = ?`).pluck().get(appunti.id)).toBe(1);

    // Moved into another subject's folder and renamed: the same source follows it and takes that subject.
    renameSync(join(root, "GAL", "appunti.txt"), join(root, "Fisica 1", "matrici.txt"));
    await app.linked.sync(folder!.id);
    const moved = app.db.prepare(`SELECT rel_path, missing_at FROM linked_files WHERE source_id = ?`).get(appunti.id);
    expect(moved).toEqual({ rel_path: join("Fisica 1", "matrici.txt"), missing_at: null });
    expect(app.subjectName(app.source("appunti")!.subjectId)).toBe("Fisica I");
    expect(app.db.prepare(`SELECT COUNT(*) FROM sources`).pluck().get()).toBe(4);

    // Touched without a change: only the recorded time moves.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "orario.txt"), later, later);
    await app.linked.sync(folder!.id);
    await app.settled();
    const orario = app.source("orario")!;
    expect(app.db.prepare(`SELECT COUNT(*) FROM source_documents WHERE source_id = ?`).pluck().get(orario.id)).toBe(1);

    // Changed: read again as the next version, the earlier passages kept for their citations.
    const fisica = app.source("Mazzoldi cap 2")!;
    const old = app.db.prepare(`SELECT id FROM passages WHERE source_id = ?`).pluck().all(fisica.id);
    writeFileSync(join(root, "Fisica 1", "Mazzoldi cap 2.md"), "# Dinamica\n\nLa forza è la massa per l'accelerazione.");
    utimesSync(join(root, "Fisica 1", "Mazzoldi cap 2.md"), later, later);
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(app.db.prepare(`SELECT MAX(version) FROM source_documents WHERE source_id = ?`).pluck().get(fisica.id)).toBe(2);
    expect(app.db.prepare(`SELECT id FROM passages WHERE source_id = ? AND version = 1`).pluck().all(fisica.id)).toEqual(old);
    expect(app.source("Mazzoldi cap 2")!.status).toBe("ready");
  });

  it("does not read again a file whose source the student removed, and marks nothing missing when the walk is cut", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    const orario = app.source("orario")!;
    app.db.prepare(`UPDATE sources SET status = 'removed' WHERE id = ?`).run(orario.id);
    app.db.prepare(`DELETE FROM passages WHERE source_id = ?`).run(orario.id);
    app.db.prepare(`DELETE FROM source_documents WHERE source_id = ?`).run(orario.id);
    // Free up space deletes the row: the file stays recorded with no source, so it is not read again.
    app.db.prepare(`DELETE FROM sources WHERE id = ?`).run(orario.id);
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(app.db.prepare(`SELECT COUNT(*) FROM sources WHERE title = 'orario'`).pluck().get()).toBe(0);
    // Removed from the Library but kept for its citations: a change to its file is not read either.
    const febbraio = app.source("febbraio")!;
    app.db.prepare(`UPDATE sources SET status = 'removed' WHERE id = ?`).run(febbraio.id);
    const later = new Date(Date.now() + 60_000);
    writeFileSync(join(root, "Fisica 1", "Temi d'esame", "febbraio.txt"), "Esercizio 2. Un corpo cade da fermo.");
    utimesSync(join(root, "Fisica 1", "Temi d'esame", "febbraio.txt"), later, later);
    const jobs = app.db.prepare(`SELECT COUNT(*) FROM jobs`).pluck().get();
    await app.linked.sync(folder!.id);
    expect(app.db.prepare(`SELECT COUNT(*) FROM jobs`).pluck().get()).toBe(jobs);

    let deep = join(root, "GAL");
    for (let level = 0; level <= MAX_FOLDER_DEPTH; level += 1) deep = join(deep, `l${level}`);
    mkdirSync(deep, { recursive: true });
    rmSync(join(root, "GAL", "appunti.txt"));
    await app.linked.sync(folder!.id);
    expect(app.source("appunti")!.missingAt).toBeNull();
    expect(app.linked.view(folder!.id).cut.depth).toBe(true);
  });

  it("marks every file missing while the folder itself is gone, and finds them when it is back", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    renameSync(root, `${root} (scollegata)`);
    await app.linked.sync(folder!.id);
    expect(app.db.prepare(`SELECT COUNT(*) FROM linked_files WHERE missing_at IS NULL`).pluck().get()).toBe(0);
    renameSync(`${root} (scollegata)`, root);
    await app.linked.sync(folder!.id);
    expect(app.db.prepare(`SELECT COUNT(*) FROM linked_files WHERE missing_at IS NOT NULL`).pluck().get()).toBe(0);
  });

  it("gives an unconfirmed folder the subjects it offered at the next start, and watches every folder", async () => {
    const root = studyTree();
    const watched: string[] = [];
    const app = setup({
      watch: (path) => {
        watched.push(path);
        return { close() {} };
      },
    });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    expect(app.source("appunti")!.subjectId).toBeNull();
    await app.linked.start();
    expect(app.subjectName(app.source("appunti")!.subjectId)).toBe("Geometria e algebra lineare");
    expect(app.linked.view(folder!.id).subjects.find((subject) => subject.key === "Erasmus")!.skipped).toBe(true);
    expect(watched).toEqual([root]);
  });

  it("still tells the window about what a look changed before it failed", async () => {
    const root = studyTree();
    let failing = "";
    const app = setup({
      hash: (paths, maxBytes) =>
        paths.includes(failing) ? Promise.reject(new Error("read failed")) : hashFiles(paths, maxBytes),
    });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    const told = app.changes.count;
    // One file goes missing and another changes, and hashing the changed one fails.
    rmSync(join(root, "GAL", "appunti.txt"));
    failing = join(root, "orario.txt");
    const later = new Date(Date.now() + 60_000);
    writeFileSync(failing, "Mercoledì: Analisi.");
    utimesSync(failing, later, later);
    await expect(app.linked.sync(folder!.id)).rejects.toThrow("read failed");
    expect(app.source("appunti")!.missingAt).not.toBeNull();
    expect(app.changes.count).toBe(told + 1);
  });

  it("gives files added later to an empty subject folder the folder's own name as their subject", async () => {
    const root = join(tempDir("pyxis-linked-"), "Chimica organica");
    mkdirSync(root);
    const app = setup({ engine: false });
    const [folder] = await app.linked.link({ paths: [root], mode: "subject" });
    expect(folder!.subjects).toEqual([]);
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
    writeFileSync(join(root, "alcani.txt"), "Gli alcani sono idrocarburi saturi a catena aperta.");
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(app.subjectName(app.source("alcani")!.subjectId)).toBe("Chimica organica");
    expect(app.linked.view(folder!.id).subjects).toMatchObject([{ key: "", folder: "Chimica organica", name: "Chimica organica" }]);
  });

  it("cuts a long subfolder name to a subject name, so confirming never fails", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    // A subfolder with a name longer than a subject holds gets its first file before setup is confirmed.
    const long = `Appunti ${"di analisi ".repeat(14)}`.trim();
    expect(long.length).toBeGreaterThan(120);
    mkdirSync(join(root, long));
    writeFileSync(join(root, long, "limiti.txt"), "Il limite di una funzione in un punto.");
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(app.linked.view(folder!.id).subjects.find((subject) => subject.key === long)!.name).toBe(
      long.slice(0, 120).trim(),
    );
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
    expect(app.subjectName(app.source("limiti")!.subjectId)).toBe(long.slice(0, 120).trim());
  });

  it("writes nothing inside the linked folder", async () => {
    const root = studyTree();
    const before = snapshot(root);
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    await app.linked.confirm({
      folders: [{ folderId: folder!.id, subjects: [{ key: "Erasmus", name: "Erasmus", skipped: false }] }],
    });
    await app.settled();
    await app.linked.sync(folder!.id);
    await app.linked.start();
    await app.settled();
    expect(app.db.prepare(`SELECT COUNT(*) FROM sources WHERE status = 'ready'`).pluck().get()).toBe(5);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("a linked scan", () => {
  it("waits for OCR while its file is there, and is read from the folder", () => {
    const root = studyTree();
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('scan', 'pdf', 'Scan', 'needs-ocr', 1, 1)`).run();
    db.prepare(`INSERT INTO linked_folders (id, path, mode, created_at) VALUES ('f', ?, 'root', 1)`).run(root);
    db.prepare(
      `INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms) VALUES ('f', ?, 'GAL', 'scan', 1, 1)`,
    ).run(join("GAL", "appunti.txt"));
    expect(waitingScans(db)).toEqual(["scan"]);
    expect(readableLinkedPath(db, "scan")).toBe(join(root, "GAL", "appunti.txt"));
    db.prepare(`UPDATE linked_files SET missing_at = 2`).run();
    expect(waitingScans(db)).toEqual([]);
    expect(linkedFile(db, "scan")).toEqual({ path: join(root, "GAL", "appunti.txt"), missing: true });
    // A file replaced by a link, or gone, is not read.
    rmSync(join(root, "GAL", "appunti.txt"));
    symlinkSync(join(root, "orario.txt"), join(root, "GAL", "appunti.txt"));
    expect(() => readableLinkedPath(db, "scan")).toThrow("source-file-missing");
    expect(() => readableLinkedPath(db, "other")).toThrow("source-file-missing");
  });
});
