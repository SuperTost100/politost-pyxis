import { chmodSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { blobSize } from "../blobs";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import { createRunner } from "../jobs/runner";
import { tempDir } from "../test-temp";
import { extractByExt } from "./documents";
import { MAX_LINKED_DEPTH } from "../../shared/linked-folders";
import { walkImportable, type WalkedFile } from "./folder";
import { hasUnfinishedJob, importGroup, registerSourceJobs } from "./jobs";
import { checkLinkPath, closeLinkedWatches, linkedFolders, peekFolder, subfolderOf } from "./linked";
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

/** The prompt that sorts loose files starts this way; the fake engines tell the two calls apart by it. */
const isSorting = (input: Parameters<Run>[0]) => input.system?.startsWith("A student keeps their study material in one folder") === true;

/** Sorts loose files by the subfolder named at the start of each file name, and leaves the rest without a subject. */
const sortByPrefix =
  (calls: string[][] = []): Run =>
  async (input) => {
    const { subjects, files } = JSON.parse(input.prompt) as { subjects: Array<{ folder: string }>; files: string[] };
    calls.push(files);
    return {
      text: "",
      provider: "claude",
      model: "claude-sonnet-5",
      inputTokens: 1,
      structured: {
        files: files.map((file) => ({
          file,
          folder: subjects.find((subject) => file.startsWith(`${subject.folder} `))?.folder ?? "",
        })),
      },
    };
  };

const tidyFolders = answer([
  { folder: "Fisica 1", subject: "Fisica I", study: true, kinds: ["book", "exams"] },
  { folder: "GAL", subject: "Geometria e algebra lineare", study: true, kinds: ["notes"] },
  { folder: "Erasmus", subject: "Erasmus", study: false, kinds: [] },
]);
const tidy: Run = async (input) => (isSorting(input) ? sortByPrefix()(input) : tidyFolders(input));

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
    storedSize: (sha) => blobSize(workspace, sha),
    ocrReady: async () => false,
    run: options.run ?? tidy,
    watch: options.watch ?? null,
    pumpMs: 10,
    onChange: () => {
      changes.count += 1;
    },
  });
  // Every look is over, and every file it recorded has gone through the queue and been read.
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
  it("groups files by first-level subfolder, keeps top-level files without a subject and samples each subject", async () => {
    const root = studyTree();
    writeFileSync(join(root, "GAL", "libro.ptsb"), "x");
    const found: WalkedFile[] = [];
    const cut = await walkImportable(root, { maxDepth: MAX_LINKED_DEPTH, onFiles: (files) => void found.push(...files) });
    expect(
      found.map((file) => [file.rel, subfolderOf("root", file.rel)]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      [join("Erasmus", "learning agreement.txt"), "Erasmus"],
      [join("Fisica 1", "Mazzoldi cap 2.md"), "Fisica 1"],
      [join("Fisica 1", "Temi d'esame", "febbraio.txt"), "Fisica 1"],
      [join("GAL", "appunti.txt"), "GAL"],
      [join("GAL", "libro.ptsb"), "GAL"],
      ["orario.txt", ""],
    ]);
    expect(found.find((file) => file.rel === "orario.txt")).toMatchObject({ size: statSync(join(root, "orario.txt")).size });
    expect(cut).toEqual({ depth: false, unreadable: false });
    // A book package is a library import, not material to name a subject by.
    const groups = await peekFolder(root, "root", []);
    expect([...groups.keys()]).toEqual(["Erasmus", "Fisica 1", "GAL"]);
    expect(groups.get("GAL")).toEqual({ folder: "GAL", files: ["appunti.txt"] });
    // One folder per subject: everything in it belongs to the folder itself.
    const fisica = join(root, "Fisica 1");
    expect(subfolderOf("subject", join("Temi d'esame", "febbraio.txt"))).toBe("");
    expect([...(await peekFolder(fisica, "subject", [])).entries()]).toEqual([
      ["", { folder: "Fisica 1", files: ["Mazzoldi cap 2.md", join("Temi d'esame", "febbraio.txt")] }],
    ]);
    // A study folder with no subfolders is one subject.
    expect([...(await peekFolder(join(root, "GAL"), "root", [])).keys()]).toEqual([""]);
    // Setup names a subject from a sample of its files, never from the whole tree.
    for (let index = 0; index < 60; index += 1) writeFileSync(join(root, "GAL", `esercizi ${index}.txt`), "x");
    expect((await peekFolder(root, "root", [])).get("GAL")!.files).toHaveLength(40);
  });

  it("reports a walk the depth cap cut, never walks into an excluded folder, and reads one place on its own", async () => {
    const root = studyTree();
    let deep = join(root, "Fisica 1");
    for (let level = 0; level <= MAX_LINKED_DEPTH; level += 1) deep = join(deep, `l${level}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "lost.txt"), "x");
    const walk = async (options: { exclude?: string[]; within?: string } = {}) => {
      const found: string[] = [];
      const cut = await walkImportable(root, {
        ...options,
        maxDepth: MAX_LINKED_DEPTH,
        onFiles: (files) => void found.push(...files.map((file) => file.rel)),
      });
      return { found: found.sort(), cut };
    };
    expect((await walk()).cut.depth).toBe(true);
    expect((await walk()).found.some((rel) => rel.endsWith("lost.txt"))).toBe(false);
    expect((await walk({ exclude: [join(root, "Erasmus")] })).found.some((rel) => rel.startsWith("Erasmus"))).toBe(false);
    // A place a watch reported: a subfolder, a file, or something gone.
    expect((await walk({ within: "GAL" })).found).toEqual([join("GAL", "appunti.txt")]);
    expect((await walk({ within: join("Fisica 1", "Mazzoldi cap 2.md") })).found).toEqual([join("Fisica 1", "Mazzoldi cap 2.md")]);
    expect((await walk({ within: "Chimica" })).found).toEqual([]);
    expect((await walk({ within: join("..", "elsewhere") })).found).toEqual([]);
    // A folder on the way that became a link is not followed, even though the place itself is a plain file.
    const outside = tempDir("pyxis-linked-outside-");
    writeFileSync(join(outside, "segreto.txt"), "x");
    symlinkSync(outside, join(root, "scorciatoia"));
    expect((await walk({ within: join("scorciatoia", "segreto.txt") })).found).toEqual([]);
  });

  it("accepts only an absolute directory outside the workspace and the app's data", () => {
    const root = studyTree();
    const workspace = tempDir("pyxis-linked-ws-");
    mkdirSync(join(workspace, "blobs"));
    // The folder comes back as the system spells it: on macOS the temp folder sits behind /var -> /private/var, and on
    // Windows a temp path can carry a short name such as RUNNER~1.
    expect(checkLinkPath(root, [workspace])).toBe(realpathSync.native(root));
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

  it("confirming again renames a folder's own subject in place, and gives a shared subject a new one", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    const first = (subjects: Array<{ key: string; name: string; skipped: boolean }>) =>
      app.linked.confirm({ folders: [{ folderId: folder!.id, subjects }] });
    await first([
      { key: "Fisica 1", name: "Fisica I", skipped: false },
      { key: "GAL", name: "Geometria", skipped: false },
      { key: "Erasmus", name: "Geometria", skipped: false },
    ]);
    await app.settled();
    const physics = app.source("Mazzoldi cap 2")!.subjectId;
    const geometry = app.source("appunti")!.subjectId;
    expect(app.source("learning agreement")!.subjectId).toBe(geometry);

    // Setup again: a subject only this subfolder has is renamed, so what hangs on its id stays with it. A subject two
    // subfolders share is left to the other one, and the renamed subfolder gets a subject of its own.
    await first([
      { key: "Fisica 1", name: "Fisica", skipped: false },
      { key: "GAL", name: "Geometria", skipped: false },
      { key: "Erasmus", name: "Erasmus", skipped: false },
    ]);
    await app.settled();
    expect(app.source("Mazzoldi cap 2")!.subjectId).toBe(physics);
    expect(app.subjectName(physics)).toBe("Fisica");
    expect(app.source("appunti")!.subjectId).toBe(geometry);
    expect(app.subjectName(geometry)).toBe("Geometria");
    expect(app.subjectName(app.source("learning agreement")!.subjectId)).toBe("Erasmus");
    expect(app.db.prepare(`SELECT name FROM subjects ORDER BY name`).pluck().all()).toEqual([
      "Erasmus",
      "Fisica",
      "Geometria",
    ]);

    // A new name that another subject already has joins that subject, as a first confirmation does.
    await first([{ key: "Fisica 1", name: "geometria", skipped: false }]);
    expect(app.source("Mazzoldi cap 2")!.subjectId).toBe(geometry);
    expect(app.subjectName(geometry)).toBe("Geometria");

    // Now GAL and Fisica 1 share Geometria. Renaming both, in either order, gives each a subject of its own and leaves
    // Geometria, with what hangs on it, as it was.
    await first([
      { key: "Fisica 1", name: "Fisica II", skipped: false },
      { key: "GAL", name: "Algebra", skipped: false },
    ]);
    expect(app.subjectName(geometry)).toBe("Geometria");
    expect(app.subjectName(app.source("Mazzoldi cap 2")!.subjectId)).toBe("Fisica II");
    expect(app.subjectName(app.source("appunti")!.subjectId)).toBe("Algebra");
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
    for (let level = 0; level <= MAX_LINKED_DEPTH; level += 1) deep = join(deep, `l${level}`);
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

/** A folder of `count` small notes spread over ten subjects and their chapters, plus `loose` files at the top. */
function bigTree(count: number, loose: string[] = []) {
  const root = join(tempDir("pyxis-linked-big-"), "Studio");
  for (let index = 0; index < count; index += 1) {
    const dir = join(root, `Materia ${index % 10}`, `cap ${Math.floor(index / 10) % 25}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `nota ${index}.txt`), `Nota ${index}`);
  }
  for (const name of loose) writeFileSync(join(root, name), name);
  return root;
}

/**
 * Linked folders over a runner whose imports only mark their source ready, so a test can read thousands of files and
 * watch the queue. `paused` leaves every queued import waiting, as a quit would.
 */
function bulk(options: { db?: ReturnType<typeof openDatabase>; paused?: boolean; window?: number; run?: Run; engine?: boolean; listAfterMs?: number } = {}) {
  const db = options.db ?? openDatabase(":memory:");
  if (!options.db && options.engine !== false)
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
    );
  const updates: Array<{ kind: string; state: string; count?: number; title?: string }> = [];
  // The most imports waiting or running at once, read at every job update.
  let mostQueued = 0;
  const runner = createRunner(
    db,
    (job) => {
      updates.push(job);
      if (job.kind === "source-import") mostQueued = Math.max(mostQueued, queuedImports());
    },
    undefined,
    options.paused === true,
  );
  let reads = 0;
  runner.register("source-import", {
    jobClass: "local",
    group: (params) => importGroup(db, params),
    steps: [
      {
        name: "read",
        label: "sources.jobs.extract",
        async run(ctx) {
          reads += 1;
          const { sourceId } = ctx.params as { sourceId: string };
          db.prepare(`UPDATE sources SET status = 'ready' WHERE id = ?`).run(sourceId);
          return {};
        },
      },
    ],
  });
  const linked = linkedFolders({
    db,
    runner,
    protectedPaths: [tempDir("pyxis-linked-ws-")],
    hash: (paths, maxBytes) => hashFiles(paths, maxBytes),
    storedSize: () => null,
    ocrReady: async () => false,
    run: options.run,
    watch: null,
    queueWindow: options.window ?? 16,
    pumpMs: 5,
    listAfterMs: options.listAfterMs ?? 1_000,
  });
  const count = (sql: string) => db.prepare(sql).pluck().get() as number;
  const queuedImports = () =>
    count(`SELECT COUNT(*) FROM jobs WHERE kind = 'source-import' AND state IN ('queued', 'running')`);
  const settled = async () => {
    await linked.idle();
    await expect
      .poll(() => queuedImports() + count(`SELECT COUNT(*) FROM linked_files WHERE pending > 0`), { timeout: 60_000 })
      .toBe(0);
  };
  return { db, runner, linked, updates, count, queuedImports, settled, reads: () => reads, mostQueued: () => mostQueued };
}

describe("a large linked folder", () => {
  it("reads 5,000 files with no cap, keeps core free while it walks, and queues them a window at a time", async () => {
    const root = bigTree(5_000);
    const app = bulk({ engine: false, listAfterMs: 0 });
    // A timer that should fire every few milliseconds: a walk that held the event loop would leave a long gap.
    let last = performance.now();
    let longest = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      ticks += 1;
    }, 2);
    const started = performance.now();
    let folderId = "";
    try {
      const [folder] = await app.linked.link({ paths: [root], mode: "root" });
      expect(folder!.subjects).toHaveLength(10);
      folderId = folder!.id;
      await app.linked.idle();
      const walked = performance.now() - started;
      expect(app.count(`SELECT COUNT(*) FROM linked_files`)).toBe(5_000);
      console.info(`linked folder: 5,000 files walked and recorded in ${Math.round(walked)} ms, longest event-loop gap ${Math.round(longest)} ms over ${ticks} ticks`);
      expect(ticks).toBeGreaterThan(10);
      expect(longest).toBeLessThan(250);
      await app.settled();
      console.info(`linked folder: 5,000 files queued and read in ${Math.round(performance.now() - started)} ms`);
    } finally {
      clearInterval(timer);
    }
    // Every file was read, once, and never more than the window waited in the queue at the same time.
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE status = 'ready'`)).toBe(5_000);
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE source_id IS NULL`)).toBe(0);
    expect(app.reads()).toBe(5_000);
    expect(app.mostQueued()).toBe(16);
    // The walk was listed in Attività with the count of files found, and left no finished job behind.
    const listed = app.updates.filter((job) => job.kind === "linked-folder-read");
    expect(listed[0]).toMatchObject({ state: "running", title: "Studio" });
    expect(listed.at(-1)).toMatchObject({ state: "succeeded", count: 5_000 });
    expect(app.count(`SELECT COUNT(*) FROM jobs WHERE kind = 'linked-folder-read'`)).toBe(0);
    // A second look finds nothing new, and reads nothing again.
    await app.linked.sync(folderId);
    await app.settled();
    expect(app.reads()).toBe(5_000);
  }, 120_000);

  it("carries on after a restart with the files still waiting, and reads none of them twice", async () => {
    const root = bigTree(600);
    const first = bulk({ engine: false, paused: true, window: 10 });
    await first.linked.link({ paths: [root], mode: "root" });
    await first.linked.idle();
    // Pyxis quits with ten readings queued and the rest of the folder recorded but not queued.
    await expect.poll(() => first.queuedImports()).toBe(10);
    expect(first.count(`SELECT COUNT(*) FROM linked_files WHERE pending = 1`)).toBe(590);
    closeLinkedWatches();
    expect(first.queuedImports()).toBe(10);
    // A file still waiting is renamed while Pyxis is closed: its old name must not be read.
    const waiting = first.db
      .prepare(`SELECT rel_path FROM linked_files WHERE pending = 1 ORDER BY rowid LIMIT 1`)
      .pluck()
      .get() as string;
    renameSync(join(root, waiting), join(root, `${waiting.slice(0, -4)} bis.txt`));

    // A wider window, so the queue has room for waiting files the moment Pyxis starts.
    const second = bulk({ db: first.db, window: 20 });
    await second.linked.start();
    await second.settled();
    expect(second.reads()).toBe(600);
    expect(second.count(`SELECT COUNT(*) FROM jobs WHERE kind = 'source-import'`)).toBe(600);
    expect(second.count(`SELECT COUNT(*) FROM sources`)).toBe(600);
    expect(second.count(`SELECT COUNT(DISTINCT source_id) FROM linked_files`)).toBe(600);
    expect(second.count(`SELECT COUNT(*) FROM linked_files WHERE missing_at IS NOT NULL`)).toBe(0);
    expect(second.count(`SELECT COUNT(*) FROM linked_files WHERE rel_path = '${waiting.replaceAll("'", "''")}'`)).toBe(0);
  }, 60_000);

  it("lists a folder's readings as one request, and hands over no more of its files while the student has them stopped", async () => {
    const root = bigTree(100);
    const app = bulk({ engine: false, paused: true, window: 10 });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.linked.idle();
    await expect.poll(() => app.queuedImports()).toBe(10);
    // Each reading names the folder, and the files not queued yet are counted on it.
    const listed = app.runner.list().filter((job) => job.kind === "source-import");
    expect(listed).toHaveLength(10);
    for (const job of listed) expect(job.group).toEqual({ id: `folder:${folder!.id}`, folder: "Studio", waiting: 90 });

    // Readings queued before an update recorded no folder: the folder is found from their source.
    app.db.exec(`UPDATE jobs SET params_json = json_remove(params_json, '$.folderId') WHERE kind = 'source-import'`);
    const stopped = app.runner.stopAll();
    expect(stopped).toHaveLength(10);
    // A few pump rounds later, the rest of the folder still waits: stopping did not just make room for the next files.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.queuedImports()).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE pending = 1`)).toBe(90);

    expect(app.runner.resumeAll(stopped)).toHaveLength(10);
    app.runner.activate();
    await app.settled();
    expect(app.reads()).toBe(100);
  }, 60_000);

  it("sorts loose files into subjects by name, a hundred names a call, and asks about each file once", async () => {
    const loose = [
      ...Array.from({ length: 100 }, (_, index) => `Analisi esercizi ${index}.txt`),
      ...Array.from({ length: 100 }, (_, index) => `Fisica appunti ${index}.txt`),
      ...Array.from({ length: 30 }, (_, index) => `orario ${index}.txt`),
    ];
    const root = join(tempDir("pyxis-linked-loose-"), "Studio");
    for (const subject of ["Analisi", "Fisica"]) {
      mkdirSync(join(root, subject), { recursive: true });
      writeFileSync(join(root, subject, "libro.txt"), subject);
    }
    for (const name of loose) writeFileSync(join(root, name), name);
    const calls: string[][] = [];
    // The model leaves the timetables out of its answer altogether.
    const sorter: Run = async (input) => {
      const reply = await sortByPrefix(calls)(input);
      const structured = reply.structured as { files: Array<{ file: string }> };
      return { ...reply, structured: { files: structured.files.filter((item) => !item.file.startsWith("orario")) } };
    };
    const app = bulk({
      run: async (input) =>
        isSorting(input)
          ? sorter(input)
          : answer([
              { folder: "Analisi", subject: "Analisi matematica I", study: true, kinds: ["exercises"] },
              { folder: "Fisica", subject: "Fisica I", study: true, kinds: ["notes"] },
            ])(input),
    });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    expect(calls.map((batch) => batch.length)).toEqual([100, 100, 30]);
    // The model saw names only, and every loose file once.
    expect(calls.flat().sort()).toEqual([...loose].sort());
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
    await app.settled();
    const subjectOf = (title: string) =>
      app.db
        .prepare(`SELECT j.name FROM sources s LEFT JOIN subjects j ON j.id = s.subject_id WHERE s.title = ?`)
        .pluck()
        .get(title);
    expect(subjectOf("Analisi esercizi 7")).toBe("Analisi matematica I");
    expect(subjectOf("Fisica appunti 99")).toBe("Fisica I");
    expect(subjectOf("orario 3")).toBeNull();
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE subfolder = '' AND sorted_at IS NULL`)).toBe(0);
    // The next look asks about nothing it asked about already.
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(calls).toHaveLength(3);
  }, 60_000);

  it("lists a failed sort of loose files in Attività as a job, leaves the files without a subject, and Riprova sorts them", async () => {
    const root = bigTree(20, ["Materia 3 appunti.txt", "orario.txt"]);
    let failing = true;
    const asked: boolean[] = [];
    const app = bulk({
      run: async (input) => {
        if (!isSorting(input)) return answer([])(input);
        asked.push(failing);
        if (failing) throw new Error("engine down");
        return sortByPrefix()(input);
      },
    });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
    await app.settled();
    const job = app.db.prepare(`SELECT id, state, error FROM jobs WHERE kind = 'linked-folder-sort'`).get() as
      | { id: string; state: string; error: string | null }
      | undefined;
    expect(job).toMatchObject({ state: "failed", error: "linked-sort-failed" });
    // The files wait without a subject, and a later look does not ask again until the student asks in Attività.
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE subfolder = '' AND sorted_at IS NULL`)).toBe(2);
    const asks = asked.length;
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(asked).toHaveLength(asks);
    failing = false;
    app.runner.retry(job!.id);
    await app.settled();
    await expect
      .poll(() => app.db.prepare(`SELECT state FROM jobs WHERE id = ?`).pluck().get(job!.id), { timeout: 10_000 })
      .toBe("succeeded");
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE subfolder = '' AND sorted_at IS NULL`)).toBe(0);
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE rel_path = 'Materia 3 appunti.txt' AND subfolder = 'Materia 3'`)).toBe(1);
    expect(app.count(`SELECT COUNT(*) FROM jobs WHERE kind = 'linked-folder-sort'`)).toBe(1);
  }, 30_000);

  describe("stopping the job that sorts loose files", () => {
    /**
     * A folder with 101 loose files, a first sort that failed (so the job exists and has failed), and a model that
     * holds its `holdCall`-th call open, as an engine that is slow to answer does, until the call is aborted or
     * `release` is called. `release` also lets a call that ignores the stop go on, so a missing stop shows as a wrong
     * result and not as a hang.
     */
    async function failedSort(holdCall: number) {
      const loose = Array.from({ length: 101 }, (_, index) => `Materia 3 appunti ${String(index).padStart(3, "0")}.txt`);
      const root = bigTree(20, loose);
      let mode: "failing" | "holding" = "failing";
      const calls: string[][] = [];
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      const app = bulk({
        run: async (input) => {
          if (!isSorting(input)) return answer([])(input);
          if (mode === "failing") throw new Error("engine down");
          const call = calls.length + 1;
          const reply = await sortByPrefix(calls)(input);
          if (call === holdCall)
            await Promise.race([
              released,
              new Promise((_, reject) =>
                input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
              ),
            ]);
          return reply;
        },
      });
      const [folder] = await app.linked.link({ paths: [root], mode: "root" });
      await app.settled();
      await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
      await app.settled();
      const jobId = app.db.prepare(`SELECT id FROM jobs WHERE kind = 'linked-folder-sort' AND state = 'failed'`).pluck().get() as string;
      expect(jobId).toBeTruthy();
      const state = () => app.db.prepare(`SELECT state FROM jobs WHERE id = ?`).pluck().get(jobId);
      const unplaced = () => app.count(`SELECT COUNT(*) FROM linked_files WHERE subfolder = '' AND sorted_at IS NULL`);
      const withSubject = () => app.count(`SELECT COUNT(*) FROM sources WHERE title LIKE 'Materia 3 appunti%' AND subject_id IS NOT NULL`);
      mode = "holding";
      return { app, jobId, calls, release, state, unplaced, withSubject };
    }

    it("aborts the call in flight, starts no other and saves nothing, and Riprendi sorts all of them", async () => {
      const t = await failedSort(1);
      t.app.runner.retry(t.jobId);
      await expect.poll(() => t.calls.length).toBe(1);
      t.app.runner.cancel(t.jobId);
      t.release();
      await expect.poll(() => t.state(), { timeout: 5_000 }).toBe("cancelled");
      expect(t.calls).toHaveLength(1);
      expect(t.unplaced()).toBe(101);
      expect(t.withSubject()).toBe(0);
      expect(t.app.runner.resumeAll([t.jobId])).toEqual([t.jobId]);
      await expect.poll(() => t.state(), { timeout: 5_000 }).toBe("succeeded");
      expect(t.calls.slice(1).map((batch) => batch.length)).toEqual([100, 1]);
      expect(t.unplaced()).toBe(0);
    }, 30_000);

    it("keeps the files placed before the stop, and Riprendi asks only about the rest", async () => {
      const t = await failedSort(2);
      t.app.runner.retry(t.jobId);
      await expect.poll(() => t.calls.length).toBe(2);
      // The first hundred are placed; the one file of the second call waits.
      t.app.runner.cancel(t.jobId);
      t.release();
      await expect.poll(() => t.state(), { timeout: 5_000 }).toBe("cancelled");
      expect(t.calls.map((batch) => batch.length)).toEqual([100, 1]);
      expect(t.unplaced()).toBe(1);
      t.app.runner.resumeAll([t.jobId]);
      await expect.poll(() => t.state(), { timeout: 5_000 }).toBe("succeeded");
      expect(t.calls.map((batch) => batch.length)).toEqual([100, 1, 1]);
      expect(t.calls[2]).toEqual(t.calls[1]);
      expect(t.unplaced()).toBe(0);
    }, 30_000);
  });

  it("without an AI tool, reads every file, keeps the folder names and leaves loose files without a subject", async () => {
    const root = bigTree(200, ["Analisi esercizi.txt", "orario.txt"]);
    const app = bulk({ engine: false });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    expect(folder!.detection).toBe("names");
    expect(folder!.subjects.every((subject) => !subject.skipped && subject.name === subject.folder)).toBe(true);
    await app.settled();
    await app.linked.confirm({ folders: [{ folderId: folder!.id, subjects: [] }] });
    await app.settled();
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE status = 'ready'`)).toBe(202);
    expect(app.count(`SELECT COUNT(*) FROM sources WHERE subject_id IS NULL`)).toBe(2);
    // Nobody was asked, so a later look with an AI tool can still sort them.
    expect(app.count(`SELECT COUNT(*) FROM linked_files WHERE sorted_at IS NOT NULL`)).toBe(0);
  });

  it("reads again only the places the watch saw change", async () => {
    const root = studyTree();
    let changed: ((paths: string[] | null) => void) | undefined;
    const app = setup({
      watch: (_path, onChange) => {
        changed = onChange;
        return { close() {} };
      },
    });
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    // One file is deleted where the watch did not look, and one is added where it did.
    rmSync(join(root, "Fisica 1", "Mazzoldi cap 2.md"));
    writeFileSync(join(root, "GAL", "vettori.txt"), "Un vettore ha modulo, direzione e verso.");
    changed!([join("GAL", "vettori.txt")]);
    await app.settled();
    expect(app.source("vettori")).toMatchObject({ status: "ready", missingAt: null });
    expect(app.source("Mazzoldi cap 2")!.missingAt).toBeNull();
    // A file deleted in a place the watch names is missing at once.
    rmSync(join(root, "GAL", "appunti.txt"));
    changed!(["GAL"]);
    await app.settled();
    expect(app.source("appunti")!.missingAt).not.toBeNull();
    expect(app.source("Mazzoldi cap 2")!.missingAt).toBeNull();
    // A request that names no place reads nothing, and the next one still runs.
    await app.linked.sync(folder!.id, []);
    await app.linked.idle();
    // A change the system reported without a name reads the whole folder.
    changed!(null);
    await app.settled();
    expect(app.source("Mazzoldi cap 2")!.missingAt).not.toBeNull();
    expect(app.linked.view(folder!.id).cut).toEqual({ depth: false, unreadable: false });
  });

  it("finds an unfinished reading through the jobs' state index", () => {
    const db = openDatabase(":memory:");
    const runner = createRunner(db, () => {}, undefined, true);
    runner.register("source-import", { jobClass: "local", steps: [{ name: "read", label: "x", run: async () => ({}) }] });
    runner.start("source-import", { sourceId: "s1" });
    const prepared: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    expect(hasUnfinishedJob(db, "s1")).toBe(true);
    db.prepare = prepare;
    expect(hasUnfinishedJob(db, "s2")).toBe(false);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${prepared[0]!}`).all("s1") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("jobs_state");
  });

  it("finds the folders with stopped readings through the jobs' state index, not by reading every import", async () => {
    const app = bulk({ engine: false, paused: true, window: 4 });
    const prepared: string[] = [];
    const prepare = app.db.prepare.bind(app.db);
    app.db.prepare = ((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof app.db.prepare;
    try {
      await app.linked.link({ paths: [bigTree(20)], mode: "root" });
      await app.linked.idle();
      await expect.poll(() => prepared.some((sql) => sql.includes("JOIN linked_files l"))).toBe(true);
    } finally {
      app.db.prepare = prepare;
    }
    const sql = prepared.find((text) => text.includes("JOIN linked_files l"))!;
    const plan = app.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("jobs_state");
  });

  it("drops a waiting change whose source was deleted, and goes on reading the rest", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    const orario = app.source("orario")!;
    // The file changed and waits for the queue, and meanwhile the student deletes its source.
    app.db.prepare(`UPDATE linked_files SET pending = 2 WHERE source_id = ?`).run(orario.id);
    app.db.prepare(`DELETE FROM passages WHERE source_id = ?`).run(orario.id);
    app.db.prepare(`DELETE FROM source_documents WHERE source_id = ?`).run(orario.id);
    app.db.prepare(`DELETE FROM sources WHERE id = ?`).run(orario.id);
    writeFileSync(join(root, "GAL", "vettori.txt"), "Un vettore ha modulo, direzione e verso.");
    await app.linked.sync(folder!.id);
    await app.settled();
    expect(app.db.prepare(`SELECT source_id, pending FROM linked_files WHERE rel_path = 'orario.txt'`).get()).toEqual({
      source_id: null,
      pending: 0,
    });
    expect(app.source("vettori")).toMatchObject({ status: "ready" });
  });

  it.skipIf(process.platform === "win32")("treats a file it may not look at as unreadable, never as deleted", async () => {
    const root = studyTree();
    const app = setup();
    const [folder] = await app.linked.link({ paths: [root], mode: "root" });
    await app.settled();
    // GAL can still be listed, but nothing inside it can be looked at.
    chmodSync(join(root, "GAL"), 0o444);
    try {
      await app.linked.sync(folder!.id);
      expect(app.source("appunti")!.missingAt).toBeNull();
      expect(app.linked.view(folder!.id).cut.unreadable).toBe(true);
    } finally {
      chmodSync(join(root, "GAL"), 0o755);
    }
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
