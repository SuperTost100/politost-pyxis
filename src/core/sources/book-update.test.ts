import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { createPlan } from "../plans/create";
import { planOrigin } from "../plans/views";
import { folderTransport } from "./books";
import { sourceHandlers } from "./handlers";
import { markStoppedImport, registerSourceJobs, type Extraction } from "./jobs";
import { parseSmartbook, smartbookChapters } from "./smartbook";
import { extractPlain } from "./documents";

type Db = ReturnType<typeof openDatabase>;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
});
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const SPEED = "La velocità media è lo spazio percorso diviso il tempo.";
const ACCEL_V1 = "L'accelerazione è la variazione di velocità nel tempo.";
const ACCEL_V2 =
  "L'accelerazione misura quanto cambia la velocità in un secondo.";
const FORCE = "La forza risultante è uguale alla massa per l'accelerazione.";
const ENERGY = "Il lavoro di una forza costante è forza per spostamento.";

/** A .ptsb like the books repository packs: its config id is the catalog id, and it carries its own version. */
function pack(version: string, edition: 1 | 2): Uint8Array {
  const chapters = [
    { id: "moti", number: 1, title: "Moti", file: "01.md" },
    { id: "forze", number: 2, title: "Forze", file: "02.md" },
    ...(edition === 2
      ? [{ id: "energia", number: 3, title: "Energia", file: "03.md" }]
      : []),
  ];
  const exercise = (id: string, chapter: number, question: string) =>
    `:::exercise{id="${id}" chapter="${chapter}"}\n${question}\n:::solution\nSoluzione di ${id}.\n:::\n:::\n`;
  return zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "fisica-demo",
        title: "Fisica di prova",
        version,
        access: "public",
        chapters,
      }),
    ),
    "chapters/01.md": strToU8(
      `## p1 | Velocità\n${SPEED}\n\n## p2 | Accelerazione\n${edition === 1 ? ACCEL_V1 : ACCEL_V2}\n`,
    ),
    "chapters/02.md": strToU8(`## p1 | Dinamica\n${FORCE}\n`),
    ...(edition === 2
      ? { "chapters/03.md": strToU8(`## p1 | Lavoro\n${ENERGY}\n`) }
      : {}),
    "esercizi.md": strToU8(
      edition === 1
        ? exercise("E1.1", 1, "Quanto vale la velocità?") +
            exercise("E1.2", 1, "Che cos'è l'accelerazione?") +
            exercise("E2.1", 2, "Calcola la forza.")
        : exercise("E1.1", 1, "Quanto vale la velocità media?") +
            exercise("E2.1", 2, "Calcola la forza.") +
            exercise("E3.1", 3, "Calcola il lavoro."),
    ),
  });
}

/** A folder laid out like books.politost.it with one book at `version`. */
function publish(site: string, version: string, bytes: Uint8Array) {
  mkdirSync(join(site, "books"), { recursive: true });
  writeFileSync(join(site, "books", `fisica-demo@${version}.ptsb`), bytes);
  writeFileSync(
    join(site, "catalog.json"),
    JSON.stringify({
      catalogVersion: 1,
      books: [
        {
          id: "fisica-demo",
          title: "Fisica di prova",
          subject: "Fisica",
          authors: ["PoliTost"],
          version,
          chapters: 3,
          package: `books/fisica-demo@${version}.ptsb`,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    }),
  );
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const jobState = (db: Db, id: string) => () =>
  (
    db.prepare("SELECT state FROM jobs WHERE id = ?").get(id) as
      { state: string } | undefined
  )?.state;
const one = <T>(db: Db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as T;
const all = <T>(db: Db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).all(...args) as T[];

type Extract = (
  input: { path: string; ext: string },
  signal: AbortSignal,
) => Promise<Extraction>;
const readBook: Extract = async (input) => ({
  book: parseSmartbook(new Uint8Array(readFileSync(input.path))),
});

function setup(extract: Extract = readBook) {
  const workspace = temp("pyxis-book-update-");
  const site = temp("pyxis-book-site-");
  const db = openDatabase(":memory:");
  const runner = createRunner(db, (job) => markStoppedImport(db, job));
  const open = () => {
    const handlers = sourceHandlers(
      db,
      workspace,
      runner,
      undefined,
      undefined,
      folderTransport(site),
    );
    // After the handlers, so the fixture reader replaces the worker the handlers registered.
    registerSourceJobs(db, workspace, runner, extract as never);
    return handlers;
  };
  const ctx = { workspace, site, db, runner, handlers: open(), open };
  return ctx;
}

/**
 * The catalog lists a new version. Core keeps a catalog read for a few minutes, so the handlers start again, as on the
 * next launch, to read it.
 */
function release(
  ctx: ReturnType<typeof setup>,
  version: string,
  bytes: Uint8Array,
) {
  publish(ctx.site, version, bytes);
  ctx.handlers = ctx.open();
}

/** Imports v1 from the catalog, builds a plan on it, and adds a lesson citing each chapter-1 paragraph plus a card. */
async function importedV1(ctx: ReturnType<typeof setup>) {
  const { db, site, handlers } = ctx;
  const v1 = pack("1.0.0", 1);
  publish(site, "1.0.0", v1);
  const added = await handlers.importBook({ id: "fisica-demo" });
  await expect
    .poll(jobState(db, added.jobId!), { timeout: 15_000 })
    .toBe("succeeded");
  const sourceId = added.sourceId;
  const { planId } = createPlan(db, { title: "Fisica", sourceIds: [sourceId] });
  const passage = (text: string) =>
    one<{ id: string }>(
      db,
      "SELECT id FROM passages WHERE source_id = ? AND text = ?",
      sourceId,
      text,
    ).id;
  db.prepare(
    "INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('cites-speed', ?, 'lesson', '{}', 1)",
  ).run(planId);
  db.prepare(
    "INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('cites-accel', ?, 'lesson', '{}', 1)",
  ).run(planId);
  db.prepare(
    "INSERT INTO item_passages (item_id, passage_id) VALUES ('cites-speed', ?)",
  ).run(passage(SPEED));
  db.prepare(
    "INSERT INTO item_passages (item_id, passage_id) VALUES ('cites-accel', ?)",
  ).run(passage(ACCEL_V1));
  db.prepare(
    "INSERT INTO cards (id, plan_id, front, back, passage_id, created_at) VALUES ('card', ?, 'Velocità?', 'Spazio su tempo', ?, 1)",
  ).run(planId, passage(ACCEL_V1));
  const exercise = (id: string) =>
    one<{ id: string }>(
      db,
      "SELECT id FROM exercises WHERE json_extract(locator_json, '$.exercise') = ?",
      id,
    ).id;
  db.prepare(
    "INSERT INTO flags (id, target_kind, target_id, created_at) VALUES ('flag-removed', 'exercise', ?, 1)",
  ).run(exercise("E1.2"));
  db.prepare(
    "INSERT INTO flags (id, target_kind, target_id, created_at) VALUES ('flag-changed', 'exercise', ?, 1)",
  ).run(exercise("E1.1"));
  return {
    sourceId,
    planId,
    v1,
    exercises: {
      changed: exercise("E1.1"),
      removed: exercise("E1.2"),
      same: exercise("E2.1"),
    },
  };
}

describe("free book catalog link", () => {
  it("records the catalog book and version on import, and still says the book is in the library", async () => {
    const ctx = setup();
    const { sourceId, v1 } = await importedV1(ctx);
    expect(
      one(
        ctx.db,
        "SELECT catalog_id, catalog_version, blob_sha FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({
      catalog_id: "fisica-demo",
      catalog_version: "1.0.0",
      blob_sha: sha(v1),
    });
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ id: "fisica-demo", sourceId, update: null }),
    ]);
    // Adding it again uses the source that is there.
    expect(
      (await ctx.handlers.importBook({ id: "fisica-demo" })).sourceId,
    ).toBe(sourceId);
    expect(one(ctx.db, "SELECT COUNT(*) AS n FROM sources")).toEqual({ n: 1 });
    ctx.db.close();
  });

  it("links a book imported before the link existed by its package hash when the catalog is read", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    ctx.db
      .prepare("UPDATE sources SET catalog_id = NULL, catalog_version = NULL")
      .run();
    await ctx.handlers.books();
    expect(
      one(
        ctx.db,
        "SELECT catalog_id, catalog_version FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({
      catalog_id: "fisica-demo",
      catalog_version: "1.0.0",
    });
    ctx.db.close();
  });

  it("links an older import the catalog has moved past by the book id and version inside its package", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    ctx.db
      .prepare("UPDATE sources SET catalog_id = NULL, catalog_version = NULL")
      .run();
    release(ctx, "1.1.0", pack("1.1.0", 2));
    const [book] = await ctx.handlers.books();
    expect(book).toMatchObject({
      sourceId,
      update: "available",
      version: "1.1.0",
    });
    expect(
      one(
        ctx.db,
        "SELECT catalog_id, catalog_version FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({
      catalog_id: "fisica-demo",
      catalog_version: "1.0.0",
    });
    ctx.db.close();
  });

  it("drops the catalog link when a free book is replaced with a document, so no update that fails is offered", async () => {
    const ctx = setup(async (input) =>
      input.ext === ".ptsb"
        ? readBook(input, new AbortController().signal)
        : { document: extractPlain(readFileSync(input.path, "utf8"), false) },
    );
    const { sourceId } = await importedV1(ctx);
    const cited = one<{ id: string }>(ctx.db, "SELECT id FROM passages WHERE source_id = ? AND text = ?", sourceId, SPEED).id;
    const path = join(temp("pyxis-book-replace-"), "Appunti.txt");
    writeFileSync(path, "Il calore cambia l'energia interna del sistema.");
    const replaced = await ctx.handlers.replace({ sourceId, path });
    const jobId = "jobId" in replaced ? String(replaced.jobId) : "";
    await expect.poll(jobState(ctx.db, jobId), { timeout: 15_000 }).toBe("succeeded");
    expect(one(ctx.db, "SELECT kind, catalog_id, catalog_version FROM sources WHERE id = ?", sourceId)).toEqual({
      kind: "text",
      catalog_id: null,
      catalog_version: null,
    });
    // The book's passages stay for what cites them.
    expect(one(ctx.db, "SELECT text FROM passages WHERE id = ?", cited)).toEqual({ text: SPEED });
    release(ctx, "1.1.0", pack("1.1.0", 2));
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ id: "fisica-demo", sourceId: null, update: null }),
    ]);
    ctx.db.close();
  });

  it("offers no update on a book an earlier version turned into a document and left linked", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    ctx.db.prepare("UPDATE sources SET kind = 'pdf', mime = 'application/pdf' WHERE id = ?").run(sourceId);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ id: "fisica-demo", sourceId: null, update: null }),
    ]);
    ctx.db.close();
  });

  it("does not offer a removed book, and a removed book can be added again", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    ctx.handlers.remove({ sourceId, confirmed: true });
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ sourceId: null, update: null }),
    ]);
    await expect(
      ctx.handlers.updateBook({ sourceId, confirmed: true }),
    ).rejects.toMatchObject({ messageKey: "sources.importFailed" });
    ctx.db.close();
  });
});

describe("updating a free book in place", () => {
  it("asks before updating a book that plans use, and downloads nothing until confirmed", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    const before = one<{ n: number }>(
      ctx.db,
      "SELECT COUNT(*) AS n FROM jobs",
    ).n;
    expect(
      await ctx.handlers.updateBook({ sourceId, confirmed: false }),
    ).toEqual({ started: false, inUse: 1 });
    expect(one(ctx.db, "SELECT COUNT(*) AS n FROM jobs")).toEqual({
      n: before,
    });
    ctx.db.close();
  });

  it("publishes a new version of the same source, keeps old citations, and flags only items whose text changed", async () => {
    const ctx = setup();
    const { db } = ctx;
    const { sourceId, planId, exercises } = await importedV1(ctx);
    db.prepare("UPDATE sources SET title = 'Fisica di prova' WHERE id = ?").run(
      sourceId,
    );
    const v2 = pack("1.1.0", 2);
    release(ctx, "1.1.0", v2);
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ sourceId, update: "available" }),
    ]);
    const started = await ctx.handlers.updateBook({
      sourceId,
      confirmed: true,
    });
    expect(started).toMatchObject({
      started: true,
      inUse: 1,
      version: "1.1.0",
    });
    await expect
      .poll(jobState(db, started.jobId!), { timeout: 15_000 })
      .toBe("succeeded");

    // Same source, a second document version, the new package, and the link moved to the new version.
    expect(one(db, "SELECT COUNT(*) AS n FROM sources")).toEqual({ n: 1 });
    expect(
      one(
        db,
        "SELECT kind, status, blob_sha, catalog_version FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({
      kind: "smartbook",
      status: "ready",
      blob_sha: sha(v2),
      catalog_version: "1.1.0",
    });
    expect(
      all(
        db,
        "SELECT version FROM source_documents WHERE source_id = ? ORDER BY version",
        sourceId,
      ),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    expect(
      smartbookChapters(db, sourceId).map((chapter) => chapter.title),
    ).toEqual(["Moti", "Forze", "Energia"]);
    expect(
      all(
        db,
        "SELECT COUNT(*) AS n FROM smartbooks WHERE source_id = ?",
        sourceId,
      ),
    ).toEqual([{ n: 1 }]);

    // Old passages keep their text for citations; only the item citing changed text is stale.
    expect(
      one(
        db,
        "SELECT p.text FROM item_passages ip JOIN passages p ON p.id = ip.passage_id WHERE ip.item_id = 'cites-accel'",
      ),
    ).toEqual({ text: ACCEL_V1 });
    expect(
      all(db, "SELECT item_id, stale FROM item_passages ORDER BY item_id"),
    ).toEqual([
      { item_id: "cites-accel", stale: 1 },
      { item_id: "cites-speed", stale: 0 },
    ]);
    expect(
      all(
        db,
        "SELECT text FROM passages WHERE source_id = ? AND version = 2 ORDER BY rowid",
        sourceId,
      ),
    ).toEqual([SPEED, ACCEL_V2, FORCE, ENERGY].map((text) => ({ text })));

    // The plan and its card are untouched, and the plan now suggests rebuilding its topics.
    expect(
      one(
        db,
        "SELECT COUNT(*) AS n FROM plan_sources WHERE plan_id = ? AND source_id = ?",
        planId,
        sourceId,
      ),
    ).toEqual({ n: 1 });
    expect(
      one(
        db,
        "SELECT front, passage_id IS NOT NULL AS linked FROM cards WHERE id = 'card'",
      ),
    ).toEqual({ front: "Velocità?", linked: 1 });
    expect(planOrigin(db, planId).needsRebuild).toBe(true);

    // Exercises keep their ids: a changed one is rewritten, a removed one stays for its flag but leaves the book.
    expect(
      one(
        db,
        "SELECT prompt, smartbook_id IS NOT NULL AS inBook FROM exercises WHERE id = ?",
        exercises.changed,
      ),
    ).toEqual({
      prompt: "Quanto vale la velocità media?",
      inBook: 1,
    });
    expect(
      one(
        db,
        "SELECT smartbook_id FROM exercises WHERE id = ?",
        exercises.removed,
      ),
    ).toEqual({ smartbook_id: null });
    expect(
      one(
        db,
        "SELECT smartbook_id IS NOT NULL AS inBook FROM exercises WHERE id = ?",
        exercises.same,
      ),
    ).toEqual({ inBook: 1 });
    expect(
      all(
        db,
        "SELECT json_extract(e.locator_json, '$.exercise') AS id FROM exercises e JOIN smartbooks b ON b.id = e.smartbook_id ORDER BY id",
      ),
    ).toEqual([{ id: "E1.1" }, { id: "E2.1" }, { id: "E3.1" }]);
    expect(
      all(
        db,
        "SELECT f.id FROM flags f JOIN exercises e ON e.id = f.target_id ORDER BY f.id",
      ),
    ).toEqual([{ id: "flag-changed" }, { id: "flag-removed" }]);

    // Up to date now, and a second update has nothing to offer.
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ sourceId, update: null }),
    ]);
    await expect(
      ctx.handlers.updateBook({ sourceId, confirmed: true }),
    ).rejects.toMatchObject({ messageKey: "sources.books.upToDate" });
    db.close();
  });

  it("keeps a title the student chose", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    ctx.db
      .prepare("UPDATE sources SET title = 'Il mio libro' WHERE id = ?")
      .run(sourceId);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    const started = await ctx.handlers.updateBook({
      sourceId,
      confirmed: true,
    });
    await expect
      .poll(jobState(ctx.db, started.jobId!), { timeout: 15_000 })
      .toBe("succeeded");
    expect(
      one(ctx.db, "SELECT title FROM sources WHERE id = ?", sourceId),
    ).toEqual({ title: "Il mio libro" });
    ctx.db.close();
  });

  it("leaves the old version in use when the new package cannot be read", async () => {
    let calls = 0;
    const ctx = setup(async (input, signal) => {
      calls += 1;
      if (calls > 1) throw new Error("chapter-missing");
      return readBook(input, signal);
    });
    const { sourceId, v1 } = await importedV1(ctx);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    const started = await ctx.handlers.updateBook({
      sourceId,
      confirmed: true,
    });
    await expect
      .poll(jobState(ctx.db, started.jobId!), { timeout: 15_000 })
      .toBe("failed");
    expect(
      one(
        ctx.db,
        "SELECT status, blob_sha, catalog_version FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({
      status: "ready",
      blob_sha: sha(v1),
      catalog_version: "1.0.0",
    });
    expect(
      one(
        ctx.db,
        "SELECT COUNT(*) AS n FROM source_documents WHERE source_id = ?",
        sourceId,
      ),
    ).toEqual({ n: 1 });
    expect(all(ctx.db, "SELECT stale FROM item_passages")).toEqual([
      { stale: 0 },
      { stale: 0 },
    ]);
    // The stopped job holds the source until it is retried or dismissed, as a stopped replacement does.
    await expect(
      ctx.handlers.updateBook({ sourceId, confirmed: true }),
    ).rejects.toMatchObject({ messageKey: "sources.busy" });
    ctx.db.close();
  });

  it("rolls the whole version back when publishing fails part way", async () => {
    const ctx = setup();
    const { sourceId, v1 } = await importedV1(ctx);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    // A trigger refuses the third new passage, after the version row and two passages were written.
    ctx.db
      .exec(`CREATE TRIGGER refuse_energy BEFORE INSERT ON passages WHEN NEW.text LIKE '%forza risultante%' AND NEW.version = 2
      BEGIN SELECT RAISE(ABORT, 'disk-full'); END;`);
    const started = await ctx.handlers.updateBook({
      sourceId,
      confirmed: true,
    });
    await expect
      .poll(jobState(ctx.db, started.jobId!), { timeout: 15_000 })
      .toBe("failed");
    expect(
      one(ctx.db, "SELECT COUNT(*) AS n FROM passages WHERE version = 2"),
    ).toEqual({ n: 0 });
    expect(
      one(
        ctx.db,
        "SELECT COUNT(*) AS n FROM source_documents WHERE source_id = ?",
        sourceId,
      ),
    ).toEqual({ n: 1 });
    expect(
      one(
        ctx.db,
        "SELECT blob_sha, status FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({ blob_sha: sha(v1), status: "ready" });
    expect(
      one(
        ctx.db,
        "SELECT COUNT(*) AS n FROM exercises WHERE json_extract(locator_json, '$.exercise') = 'E3.1'",
      ),
    ).toEqual({ n: 0 });
    ctx.db.close();
  });

  it("can be cancelled while it reads the package, and the old version stays", async () => {
    let calls = 0;
    const ctx = setup((input, signal) => {
      calls += 1;
      if (calls === 1) return readBook(input, signal);
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
    });
    const { sourceId, v1 } = await importedV1(ctx);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    const started = await ctx.handlers.updateBook({
      sourceId,
      confirmed: true,
    });
    await expect.poll(() => calls).toBe(2);
    expect(await ctx.handlers.books()).toEqual([
      expect.objectContaining({ sourceId, update: "running" }),
    ]);
    ctx.runner.cancel(started.jobId!);
    await expect
      .poll(jobState(ctx.db, started.jobId!), { timeout: 15_000 })
      .toBe("cancelled");
    expect(
      one(
        ctx.db,
        "SELECT status, blob_sha FROM sources WHERE id = ?",
        sourceId,
      ),
    ).toEqual({ status: "ready", blob_sha: sha(v1) });
    expect(
      one(
        ctx.db,
        "SELECT COUNT(*) AS n FROM source_documents WHERE source_id = ?",
        sourceId,
      ),
    ).toEqual({ n: 1 });
    ctx.db.close();
  });

  it("refuses a package that does not match the catalog and starts nothing", async () => {
    const ctx = setup();
    const { sourceId } = await importedV1(ctx);
    release(ctx, "1.1.0", pack("1.1.0", 2));
    writeFileSync(
      join(ctx.site, "books", "fisica-demo@1.1.0.ptsb"),
      pack("1.1.0", 1),
    );
    const before = one<{ n: number }>(
      ctx.db,
      "SELECT COUNT(*) AS n FROM jobs",
    ).n;
    await expect(
      ctx.handlers.updateBook({ sourceId, confirmed: true }),
    ).rejects.toMatchObject({ messageKey: "sources.books.integrity" });
    expect(one(ctx.db, "SELECT COUNT(*) AS n FROM jobs")).toEqual({
      n: before,
    });
    expect(
      one(ctx.db, "SELECT status FROM sources WHERE id = ?", sourceId),
    ).toEqual({ status: "ready" });
    ctx.db.close();
  });
});
