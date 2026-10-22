import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { expect } from "vitest";
import { createRunner } from "../jobs/runner";
import { extractByExt } from "./documents";
import type { Embedder } from "./retrieve";
import { enqueueSourceData, enqueueSourceFile, registerSourceJobs, type Extraction } from "./jobs";

type Queued = { sourceId: string; jobId: string };

/**
 * Imports through the job runner, as the app does, with the extract worker's read done in-process. Each call waits for
 * its job to succeed. `extract` replaces the read, for images and other files the documents extractor does not handle.
 */
export function sourceImports(
  db: Database.Database,
  workspace: string,
  extract: (input: { path: string; ext: string; password?: string }) => Promise<Extraction> = async (input) => ({
    document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext, input.password),
  }),
) {
  const runner = createRunner(db, () => {});
  registerSourceJobs(db, workspace, runner, extract);
  const settle = async <T extends Queued>(queued: T): Promise<T> => {
    await expect
      .poll(() => (db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(queued.jobId) as { state: string }).state)
      .toBe("succeeded");
    return queued;
  };
  return {
    runner,
    file: async (path: string) => settle(await enqueueSourceFile(db, workspace, runner, path)),
    replace: async (sourceId: string, path: string) =>
      settle(await enqueueSourceFile(db, workspace, runner, path, sourceId)),
    data: (bytes: Uint8Array, ext: string, title: string) =>
      settle(enqueueSourceData(db, workspace, runner, bytes, ext, title)),
  };
}

/** Write vectors for passages that do not have one yet. `embed` stands in for the model. */
export function indexVectors(db: Database.Database, embed: Embedder): number {
  const rows = db
    .prepare(
      `SELECT p.rowid AS n, p.text FROM passages p
       WHERE p.source_id IS NULL
          OR p.document_id = (
            SELECT id FROM source_documents
            WHERE source_id = p.source_id
            ORDER BY version DESC
            LIMIT 1
          )`,
    )
    .all() as Array<{ n: number; text: string }>;
  const has = db.prepare(`SELECT 1 AS n FROM passages_vec WHERE passage_rowid = ?`);
  const insert = db.prepare(
    `INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`,
  );
  let count = 0;
  for (const row of rows) {
    const key = BigInt(row.n);
    if (has.get(key)) continue;
    const vector = embed(`passage: ${row.text}`);
    if (vector.length !== 384) throw new Error("embed-dim");
    const tight = new Float32Array(vector);
    insert.run(key, Buffer.from(tight.buffer));
    count += 1;
  }
  return count;
}
