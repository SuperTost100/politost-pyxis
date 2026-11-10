import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { tempDir } from "../test-temp";
import { extractByExt } from "./documents";
import { sourceHandlers } from "./handlers";
import { enqueueSourceData, enqueueSourceFile, registerSourceJobs, SourceExists, type Extraction } from "./jobs";
import { linkedFolders } from "./linked";
import { hashFiles } from "./quality";

/** What an import that found its material already there throws, with the source it points at. */
async function refused(run: () => unknown): Promise<SourceExists> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SourceExists) return error;
    throw error;
  }
  throw new Error("the import started a second source");
}

const NOTES = "La velocità è la derivata dello spazio rispetto al tempo. ".repeat(40);

/** A workspace with the import jobs registered. `extract` stands in for the worker's read, so a test can hold one open. */
function setup(extract?: (input: { path: string; ext: string }) => Promise<Extraction>) {
  const db = openDatabase(":memory:");
  const workspace = tempDir("pyxis-dup-ws-");
  const runner = createRunner(db, () => {});
  registerSourceJobs(
    db,
    workspace,
    runner,
    extract ??
      (async (input) => ({ document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) })),
    { hash: (paths, maxBytes) => hashFiles(paths, maxBytes) },
  );
  const sources = () =>
    db.prepare(`SELECT id, status, library FROM sources WHERE status != 'removed' ORDER BY rowid`).all() as Array<{
      id: string;
      status: string;
      library: number;
    }>;
  const jobs = () => db.prepare(`SELECT COUNT(*) FROM jobs WHERE kind LIKE 'source-import%'`).pluck().get() as number;
  const file = (name: string, text = NOTES) => {
    const path = join(tempDir("pyxis-dup-files-"), name);
    writeFileSync(path, text);
    return path;
  };
  const idle = () =>
    expect.poll(() => db.prepare(`SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running')`).pluck().get()).toBe(0);
  const add = (path: string, existingId?: string, batch?: { id: string }) =>
    enqueueSourceFile(db, workspace, runner, path, existingId, batch);
  return { db, workspace, runner, sources, jobs, file, idle, add };
}

describe("the same material imported twice", () => {
  it("a file imported twice is one source and one job", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const first = await app.add(path);
    await app.idle();
    const again = await refused(() => app.add(path));
    expect(app.sources()).toHaveLength(1);
    expect(again.sourceId).toBe(first.sourceId);
    expect(app.jobs()).toBe(1);
  });

  it("the same bytes under another name are the same source", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const copy = join(tempDir("pyxis-dup-copy-"), "copia di appunti.txt");
    copyFileSync(path, copy);
    const first = await app.add(path);
    await app.idle();
    const again = await refused(() => app.add(copy));
    expect(app.sources()).toHaveLength(1);
    expect(again.sourceId).toBe(first.sourceId);
  });

  it("a file twice in one batch is one source", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const batch = { id: "batch-1" };
    const results = await Promise.allSettled([app.add(path, undefined, batch), app.add(path, undefined, batch)]);
    expect(app.sources()).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(app.jobs()).toBe(1);
    await app.idle();
  });

  it("a second import while the first is queued is one source", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const first = await app.add(path);
    expect(app.sources()[0]?.status).toBe("queued");
    const again = await refused(() => app.add(path));
    expect(app.sources()).toHaveLength(1);
    expect(again.sourceId).toBe(first.sourceId);
    await app.idle();
  });

  it("a second import while the first is being read is one source", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const app = setup(async (input) => {
      await held;
      return { document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext) };
    });
    const path = app.file("appunti.txt");
    const first = await app.add(path);
    await expect.poll(() => app.sources()[0]?.status).toBe("extracting");
    const again = await refused(() => app.add(path));
    release();
    await app.idle();
    expect(app.sources()).toHaveLength(1);
    expect(again.sourceId).toBe(first.sourceId);
    expect(app.jobs()).toBe(1);
  });

  it("text pasted twice is one source, whatever the title", async () => {
    const app = setup();
    const bytes = new TextEncoder().encode(NOTES.trim());
    const first = enqueueSourceData(app.db, app.workspace, app.runner, bytes, ".txt", "Cinematica");
    const again = await refused(() =>
      enqueueSourceData(app.db, app.workspace, app.runner, bytes, ".txt", "Un altro titolo"),
    );
    expect(app.sources()).toHaveLength(1);
    expect(again).toMatchObject({ sourceId: first.sourceId, title: "Cinematica" });
    await app.idle();
  });

  it("a link saved twice is one source, and two different links stay two", async () => {
    const app = setup();
    const save = (href: string) =>
      enqueueSourceData(app.db, app.workspace, app.runner, new Uint8Array(), ".md", new URL(href).hostname, href);
    const first = save("https://example.org/fisica");
    const again = await refused(() => save("https://example.org/fisica"));
    const other = save("https://example.org/chimica");
    expect(again.sourceId).toBe(first.sourceId);
    expect(other.sourceId).not.toBe(first.sourceId);
    expect(app.sources()).toHaveLength(2);
  });

  it("a copy hidden in a chat or a plan joins the Library instead of becoming a second source", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const first = await app.add(path);
    await app.idle();
    app.db.prepare(`UPDATE sources SET library = 0 WHERE id = ?`).run(first.sourceId);
    const again = await refused(() => app.add(path));
    expect(again.sourceId).toBe(first.sourceId);
    expect(app.sources()).toEqual([{ id: first.sourceId, status: "ready", library: 1 }]);
  });

  it("a file whose earlier import failed is read again as a new source", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const first = await app.add(path);
    await app.idle();
    app.db.prepare(`UPDATE sources SET status = 'failed' WHERE id = ?`).run(first.sourceId);
    const second = await app.add(path);
    expect(second.sourceId).not.toBe(first.sourceId);
    await app.idle();
  });

  it("replacing a source with a file still starts a read, even when the bytes are in another source", async () => {
    const app = setup();
    const a = await app.add(app.file("a.txt", NOTES));
    const b = await app.add(app.file("b.txt", `${NOTES} Seconda parte.`));
    await app.idle();
    const replaced = await app.add(app.file("c.txt", NOTES), b.sourceId);
    expect(replaced.sourceId).toBe(b.sourceId);
    expect(a.sourceId).not.toBe(b.sourceId);
    await app.idle();
  });

  it("a file that a linked folder already reads is not copied into the Library", async () => {
    const app = setup();
    const root = join(tempDir("pyxis-dup-linked-"), "Università");
    mkdirSync(join(root, "Fisica"), { recursive: true });
    writeFileSync(join(root, "Fisica", "appunti.txt"), NOTES);
    const linked = linkedFolders({
      db: app.db,
      runner: app.runner,
      protectedPaths: [app.workspace],
      hash: (paths, maxBytes) => hashFiles(paths, maxBytes),
      ocrReady: async () => false,
      watch: null,
      pumpMs: 10,
    });
    await linked.link({ paths: [root], mode: "root" });
    await linked.idle();
    await app.idle();
    const [theirs] = app.sources();
    expect(theirs?.status).toBe("ready");
    // Another copy of the same file, from outside the folder.
    const again = await refused(() => app.add(app.file("copia.txt")));
    expect(app.sources()).toHaveLength(1);
    expect(again.sourceId).toBe(theirs!.id);
  });
});

describe("what the handlers answer", () => {
  it("answers a repeated import, paste or link with the source it already is, and starts nothing", async () => {
    const db = openDatabase(":memory:");
    const handlers = sourceHandlers(db, tempDir("pyxis-dup-handlers-"), createRunner(db, () => {}));
    const path = join(tempDir("pyxis-dup-handlers-files-"), "appunti.txt");
    writeFileSync(path, NOTES);
    const jobs = () => db.prepare(`SELECT COUNT(*) FROM jobs WHERE kind LIKE 'source-import%'`).pluck().get();

    const imported = await handlers.importFile({ path });
    expect(imported).not.toHaveProperty("existing");
    expect(await handlers.importFile({ path })).toMatchObject({ sourceId: imported.sourceId, existing: true });

    const text = `${NOTES.trim()} Una nota incollata.`;
    const pasted = await handlers.paste({ title: "Nota", text });
    expect(await handlers.paste({ title: "Nota", text })).toMatchObject({ sourceId: pasted.sourceId, existing: true });

    const link = await handlers.link({ url: "https://example.org/fisica" });
    expect(await handlers.link({ url: "https://example.org/fisica" })).toMatchObject({
      sourceId: link.sourceId,
      existing: true,
    });

    expect(db.prepare(`SELECT COUNT(*) FROM sources`).pluck().get()).toBe(3);
    expect(jobs()).toBe(3);
  });
});
