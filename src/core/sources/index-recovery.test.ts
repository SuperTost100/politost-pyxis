import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import {
  addExtractionVersion,
  extractPlain,
  storeExtracted,
} from "./documents";
import { indexModelVectors } from "./embed";
import { sourceHandlers } from "./handlers";
import { enqueueReextract, enqueueSourceFile } from "./jobs";

// The embedding worker is stood in for, so a test can change the source while a batch is being embedded.
let duringEmbed: (() => void) | undefined;
vi.mock("./worker-client", () => ({
  runSourceWorker: async (_name: string, input: { texts: string[] }) => {
    duringEmbed?.();
    return input.texts.map(() => {
      const vector = new Array<number>(384).fill(0);
      vector[0] = 1;
      return vector;
    });
  },
}));

const dirs: string[] = [];
afterEach(() => {
  duringEmbed = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-index-recovery-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  // Paused, so a job started here stays queued instead of running.
  const runner = createRunner(db, () => {}, undefined, true);
  // Registers the import and index jobs the app registers. Nothing runs while the runner is paused.
  sourceHandlers(db, workspace, runner);
  const text = new TextEncoder().encode("La velocità descrive lo spostamento.");
  const stored = storeExtracted(db, workspace, {
    title: "Fisica",
    kind: "text",
    mime: "text/plain",
    ext: ".txt",
    bytes: text,
    extracted: extractPlain("Vecchio testo", false),
  });
  return { workspace, db, runner, sourceId: stored.sourceId };
}
const kindState = (db: ReturnType<typeof openDatabase>, id: string) =>
  db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(id);
const reextract = (c: ReturnType<typeof setup>) => () =>
  enqueueReextract(c.db, c.workspace, c.runner, c.sourceId, true);
const replace = async (c: ReturnType<typeof setup>) => {
  const path = join(c.workspace, "new.txt");
  writeFileSync(path, "Un testo sostitutivo, abbastanza lungo.");
  return enqueueSourceFile(c.db, c.workspace, c.runner, path, c.sourceId);
};

describe("a stopped source-index job does not hold a source", () => {
  it("a queued index job blocks, as any active job does", async () => {
    const c = setup();
    const id = c.runner.start("source-index", { sourceId: c.sourceId });
    expect(kindState(c.db, id)).toEqual({ state: "queued" });
    expect(reextract(c)).toThrow("source-busy");
    await expect(replace(c)).rejects.toThrow("source-busy");
    c.db.close();
  });

  it("a cancelled index job, a failed one and an interrupted one no longer block Re-extract or Replace", async () => {
    const c = setup();
    // Cancelled from the jobs list while queued.
    const cancelled = c.runner.start("source-index", { sourceId: c.sourceId });
    c.runner.cancel(cancelled);
    expect(kindState(c.db, cancelled)).toEqual({ state: "cancelled" });
    // Failed, as a job that threw would end.
    const failed = c.runner.start("source-index", { sourceId: c.sourceId });
    c.db
      .prepare(`UPDATE jobs SET state = 'failed', error = 'boom' WHERE id = ?`)
      .run(failed);
    // Interrupted by quitting while it ran: a new runner turns every running job into interrupted at start.
    const running = c.runner.start("source-index", { sourceId: c.sourceId });
    c.db.prepare(`UPDATE jobs SET state = 'running' WHERE id = ?`).run(running);
    createRunner(c.db, () => {}, undefined, true);
    expect(kindState(c.db, running)).toEqual({ state: "interrupted" });
    expect(
      c.runner
        .list()
        .filter((job) => job.kind === "source-index")
        .map((job) => job.state)
        .sort(),
    ).toEqual(["cancelled", "failed", "interrupted"]);
    const started = reextract(c)();
    expect(started).toMatchObject({ started: true });
    c.db
      .prepare(`UPDATE jobs SET state = 'succeeded' WHERE id = ?`)
      .run(started.jobId);
    const replaced = await replace(c);
    expect(replaced.sourceId).toBe(c.sourceId);
    c.db.close();
  });

  it("a stopped import or extraction still blocks, since it holds a half-made version", async () => {
    for (const state of ["failed", "cancelled", "interrupted"]) {
      const c = setup();
      const id = c.runner.start("source-import", { sourceId: c.sourceId });
      c.db.prepare(`UPDATE jobs SET state = ? WHERE id = ?`).run(state, id);
      expect(reextract(c)).toThrow("source-busy");
      await expect(replace(c)).rejects.toThrow("source-busy");
      c.db.close();
    }
  });
});

describe("a late index job never writes vectors for a superseded version", () => {
  it("drops a batch whose passages stopped being the latest while it was embedding, and indexes the new version", async () => {
    const c = setup();
    const oldIds = (
      c.db
        .prepare(`SELECT rowid AS n FROM passages WHERE source_id = ?`)
        .all(c.sourceId) as Array<{ n: number }>
    ).map((row) => row.n);
    let swapped = false;
    duringEmbed = () => {
      if (swapped) return;
      swapped = true;
      // The text is read again and published as a new version while this batch is being embedded.
      addExtractionVersion(
        c.db,
        c.sourceId,
        extractPlain("Testo riletto bene", false),
      );
    };
    await indexModelVectors(
      c.db,
      "fixture",
      new AbortController().signal,
      c.sourceId,
    );
    const indexed = (
      c.db
        .prepare(`SELECT passage_rowid AS n FROM passages_vec`)
        .all() as Array<{ n: bigint | number }>
    ).map((row) => Number(row.n));
    expect(swapped).toBe(true);
    for (const id of oldIds) expect(indexed).not.toContain(id);
    const latest = c.db
      .prepare(
        `SELECT rowid AS n FROM passages WHERE source_id = ? AND version = 2`,
      )
      .all(c.sourceId) as Array<{ n: number }>;
    expect(latest.length).toBeGreaterThan(0);
    expect(indexed.sort()).toEqual(latest.map((row) => row.n).sort());
    c.db.close();
  });
});
