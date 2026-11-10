import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { tempDir } from "../test-temp";
import { sourceHandlers } from "./handlers";
import { enqueueSourceData, enqueueSourceFile, registerSourceJobs, SourceExists, type Extraction } from "./jobs";
import { linkedFolders } from "./linked";
import { extractByExt, extractPlain } from "./documents";
import { EXISTING_LINK_SQL, existingLinkFor, hashFiles } from "./quality";
import { hasBlob } from "../blobs";
import { commitStaged } from "../chat/attach";
import { deleteChat } from "../chat/turn";
import { promoteSource, removeSource } from "./manage";

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

  it("a removed source is read again as a new one", async () => {
    const app = setup();
    const path = app.file("appunti.txt");
    const first = await app.add(path);
    await app.idle();
    removeSource(app.db, first.sourceId, true);
    const second = await app.add(path);
    expect(second.sourceId).not.toBe(first.sourceId);
    await app.idle();
    expect(app.sources().map((row) => row.id)).toEqual([second.sourceId]);
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

describe("a chat's own copy of a file", () => {
  /** A document attached to a chat the way a turn does it: a hidden source in the chat's scope. */
  function attach(app: ReturnType<typeof setup>, chatId: string, text = NOTES): string {
    app.db
      .prepare(`INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES (?, 't', '[]', 1, 1)`)
      .run(chatId);
    const { sourceIds } = commitStaged(
      app.db,
      app.workspace,
      {
        blobs: [],
        documents: [
          { filePath: "/x/appunti.txt", ext: ".txt", bytes: new TextEncoder().encode(text), extracted: extractPlain(text, false) },
        ],
      },
      (ids) => app.db.prepare(`UPDATE chats SET scope_json = ? WHERE id = ?`).run(JSON.stringify(ids), chatId),
    );
    return sourceIds[0]!;
  }
  const row = (app: ReturnType<typeof setup>, id: string) =>
    app.db.prepare(`SELECT library, status FROM sources WHERE id = ?`).get(id);
  const passages = (app: ReturnType<typeof setup>, id: string) =>
    app.db.prepare(`SELECT COUNT(*) FROM passages WHERE source_id = ?`).pluck().get(id) as number;
  const blob = (app: ReturnType<typeof setup>) =>
    hasBlob(app.workspace, createHash("sha256").update(NOTES).digest("hex"));

  it("is not the library's: importing the file makes its own source, and deleting the chat keeps that one", async () => {
    const app = setup();
    const hidden = attach(app, "c");
    const imported = await app.add(app.file("appunti.txt"));
    await app.idle();
    expect(imported.sourceId).not.toBe(hidden);
    deleteChat(app.db, app.workspace, "c");
    expect(row(app, hidden)).toBeUndefined();
    expect(row(app, imported.sourceId)).toEqual({ library: 1, status: "ready" });
    expect(passages(app, imported.sourceId)).toBeGreaterThan(0);
    expect(blob(app)).toBe(true);
  });

  it("promoted to the library, it is the library's: importing the file finds it, and deleting the chat keeps it", async () => {
    const app = setup();
    const hidden = attach(app, "c");
    promoteSource(app.db, hidden);
    const again = await refused(() => app.add(app.file("appunti.txt")));
    expect(again.sourceId).toBe(hidden);
    deleteChat(app.db, app.workspace, "c");
    expect(row(app, hidden)).toEqual({ library: 1, status: "ready" });
    expect(passages(app, hidden)).toBeGreaterThan(0);
    expect(blob(app)).toBe(true);
  });

  it("attached after the file is in the library, it is a separate copy, and deleting the chat keeps the library source", async () => {
    const app = setup();
    const library = await app.add(app.file("appunti.txt"));
    await app.idle();
    const hidden = attach(app, "c");
    expect(hidden).not.toBe(library.sourceId);
    deleteChat(app.db, app.workspace, "c");
    expect(row(app, hidden)).toBeUndefined();
    expect(row(app, library.sourceId)).toEqual({ library: 1, status: "ready" });
    expect(passages(app, library.sourceId)).toBeGreaterThan(0);
    expect(blob(app)).toBe(true);
  });
});

describe("finding a saved link", () => {
  const save = (app: ReturnType<typeof setup>, href: string) =>
    enqueueSourceData(app.db, app.workspace, app.runner, new Uint8Array(), ".md", new URL(href).hostname, href);

  it("matches a queued link by the address its job will fetch, and a fetched one by the address it ended on", async () => {
    const app = setup();
    const queued = save(app, "https://example.org/a");
    const other = save(app, "https://example.org/b");
    // The page behind /a redirected: the source now records where it ended, while its job still names /a.
    app.db.prepare(`UPDATE sources SET origin_url = ? WHERE id = ?`).run("https://example.org/final", queued.sourceId);
    expect(existingLinkFor(app.db, "https://example.org/a")).toBe(queued.sourceId);
    expect(existingLinkFor(app.db, "https://example.org/final")).toBe(queued.sourceId);
    expect(existingLinkFor(app.db, "https://example.org/b")).toBe(other.sourceId);
    expect(existingLinkFor(app.db, "https://example.org/c")).toBeNull();
    // A job's address never matches another source's id.
    expect(existingLinkFor(app.db, "https://example.org/final/b")).toBeNull();
  });

  it("stops matching a link's address once the source was replaced with a file", () => {
    const app = setup();
    const link = save(app, "https://example.org/a");
    const done = app.db.prepare(`UPDATE jobs SET state = 'succeeded' WHERE json_extract(params_json, '$.sourceId') = ?`);
    // Fetched after a redirect: the source records where it ended and the finished job still names /a.
    done.run(link.sourceId);
    app.db.prepare(`UPDATE sources SET origin_url = ? WHERE id = ?`).run("https://example.org/final", link.sourceId);
    expect(existingLinkFor(app.db, "https://example.org/a")).toBe(link.sourceId);
    // Replaced with a file: the source has no address any more, so the old job's address must not find it.
    app.db.prepare(`UPDATE sources SET origin_url = NULL, fetched_at = NULL WHERE id = ?`).run(link.sourceId);
    expect(existingLinkFor(app.db, "https://example.org/a")).toBeNull();
  });

  it("skips a link that is removed, failed or kept out of the library", () => {
    const app = setup();
    for (const change of [`status = 'removed'`, `status = 'failed'`, `status = 'cancelled'`, `status = 'interrupted'`, `library = 0`]) {
      const href = `https://example.org/${change.replace(/\W/g, "")}`;
      const link = save(app, href);
      expect(existingLinkFor(app.db, href)).toBe(link.sourceId);
      app.db.prepare(`UPDATE sources SET ${change} WHERE id = ?`).run(link.sourceId);
      expect([change, existingLinkFor(app.db, href)]).toEqual([change, null]);
    }
  });

  it("looks the jobs up once, not once per source", () => {
    const app = setup();
    const plan = (app.db.prepare(`EXPLAIN QUERY PLAN ${EXISTING_LINK_SQL}`).all({ url: "https://example.org/a" }) as Array<{
      detail: string;
    }>)
      .map((step) => step.detail)
      .join(" | ");
    expect(plan).not.toMatch(/CORRELATED/);
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
