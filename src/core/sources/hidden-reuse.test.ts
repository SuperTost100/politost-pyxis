import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { sourceHandlers } from "./handlers";
import { listSources } from "./smartbook";
import type { BooksTransport } from "./books";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = "a".repeat(64);
const catalog: BooksTransport = async () =>
  new TextEncoder().encode(
    JSON.stringify({
      catalogVersion: 1,
      books: [
        {
          id: "fisica",
          title: "Fisica 1",
          subject: "Fisica",
          authors: [],
          version: "1.0.0",
          chapters: 2,
          package: "books/fisica@1.0.0.ptsb",
          bytes: 10,
          sha256: sha,
        },
      ],
    }),
  );

/** A source that a chat attachment or a plan file left out of the library. */
function setup(library: 0 | 1) {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-hidden-reuse-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO sources (id, kind, title, blob_sha, status, library, created_at, updated_at)
     VALUES ('hidden', 'smartbook', 'Fisica 1', ?, 'ready', ?, 1, 1)`,
  ).run(sha, library);
  const runner = createRunner(db, () => {});
  const handlers = sourceHandlers(
    db,
    workspace,
    runner,
    (path) => path,
    (async () => [sha]) as never,
    catalog,
  );
  return { db, handlers };
}

describe("library flows and sources hidden in a chat or plan", () => {
  it("does not call a book in the library when only a hidden copy exists", async () => {
    const { handlers } = setup(0);
    expect((await handlers.books())?.[0]?.sourceId).toBeNull();
  });

  it("still calls a book in the library when the library has it", async () => {
    const { handlers } = setup(1);
    expect((await handlers.books())?.[0]?.sourceId).toBe("hidden");
  });

  it("adding a book whose copy is hidden brings that copy into the library", async () => {
    const { db, handlers } = setup(0);
    const added = await handlers.importBook({ id: "fisica" });
    expect(added?.sourceId).toBe("hidden");
    expect(listSources(db).map((source) => source.id)).toEqual(["hidden"]);
  });

  it("a folder scan only flags files that the library already has", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-hidden-folder-"));
    dirs.push(dir);
    writeFileSync(join(dir, "fisica.pdf"), "x");
    const hidden = setup(0);
    expect((await hidden.handlers.scanFolder({ path: dir })).files[0]?.duplicate).toBe(false);
    const shown = setup(1);
    expect((await shown.handlers.scanFolder({ path: dir })).files[0]?.duplicate).toBe(true);
  });
});
