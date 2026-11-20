import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { removeBlob, hasBlob } from "../blobs";
import { createRunner } from "../jobs/runner";
import { extractByExt, kindFor, mimeFor, storeExtracted, type ExtractedDocument } from "../sources/documents";
import { markStoppedImport, registerSourceJobs, type Extraction } from "../sources/jobs";
import { sha256 } from "../sources/quality";
import type { VisionImage } from "../sources/vision-image";
import { createHeldFiles, type HeldFiles, type TakenFiles } from "./held-files";

/**
 * The files of a composer with the Library's import job behind them, read in this process instead of the extract worker,
 * and the job runner's updates wired to them as the app does it. `extract` replaces the read, `fit` the photo fitting,
 * and `scan` the start of a scan's page-by-page reading.
 */
export function heldFilesFor(
  db: Database.Database,
  workspace: string,
  options: {
    extract?: (input: { path: string; ext: string; password?: string }, signal: AbortSignal) => Promise<Extraction>;
    fit?: (path: string, ext: string, signal?: AbortSignal) => Promise<VisionImage>;
    scan?: (sourceId: string) => Promise<"started" | "needs-data">;
    emit?: Parameters<typeof createHeldFiles>[0]["emit"];
    /** Hooks of the Library's import job, such as the one a scan calls when its import is over. */
    jobDeps?: Parameters<typeof registerSourceJobs>[4];
  } = {},
) {
  let held!: HeldFiles;
  const runner = createRunner(db, (job) => {
    markStoppedImport(db, job);
    held.onJob(job);
  });
  registerSourceJobs(
    db,
    workspace,
    runner,
    options.extract ??
      (async (input) => ({ document: await extractByExt(new Uint8Array(readFileSync(input.path)), input.ext, input.password) })),
    options.jobDeps,
  );
  held = createHeldFiles({ db, workspace, runner, emit: options.emit ?? (() => {}), fit: options.fit, scan: options.scan });
  /** Attaches the files, waits until each is read, and takes them as a turn does. The ids go with `held` to `askTurn`. */
  const attach = async (...paths: string[]) => {
    const views = [];
    for (const path of paths) views.push(await held.attach(path));
    const ids = views.map((view) => view.id);
    await held.settle(ids);
    return { ids, views, take: (): TakenFiles => held.take(ids) };
  };
  return { held, runner, attach };
}

/**
 * A hidden document attached to a chat as it is after a turn: the source with its passages, out of the Library, stored in
 * one transaction with whatever `persist` writes. For tests that need a chat's own copy without running a turn.
 */
export function commitStaged<T = undefined>(
  db: Database.Database,
  workspace: string,
  { documents }: { blobs?: unknown[]; documents: Array<{ filePath: string; ext: string; bytes: Uint8Array; extracted: ExtractedDocument }> },
  persist?: (sourceIds: string[]) => T,
): { sourceIds: string[]; value: T } {
  const fresh = documents.map((doc) => sha256(doc.bytes)).filter((sha) => !hasBlob(workspace, sha));
  try {
    return db.transaction(() => {
      const sourceIds = documents.map(({ filePath, ext, bytes, extracted }) => {
        const source = storeExtracted(db, workspace, {
          title: basename(filePath, extname(filePath)),
          kind: kindFor(ext),
          mime: mimeFor(ext),
          ext,
          bytes,
          extracted,
        });
        db.prepare(`UPDATE sources SET library = 0 WHERE id = ?`).run(source.sourceId);
        return source.sourceId;
      });
      return { sourceIds, value: persist?.(sourceIds) as T };
    })();
  } catch (error) {
    for (const sha of fresh) removeBlob(workspace, sha);
    throw error;
  }
}


