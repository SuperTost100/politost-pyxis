import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { blobParts } from "../../shared/blob-path";
import {
  blobUse,
  chatListedSources,
  deleteHiddenSources,
  deleteRemovedSources,
} from "../chat/delete";

export type PlanUsage = { id: string; title: string; bytes: number };

export function planDiskUsage(db: Database.Database, workspace: string): PlanUsage[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, s.blob_sha
       FROM plans p
       LEFT JOIN plan_sources ps ON ps.plan_id = p.id
       LEFT JOIN sources s ON s.id = ps.source_id
       ORDER BY p.created_at`,
    )
    .all() as Array<{ id: string; title: string; blob_sha: string | null }>;
  const plans = new Map<string, { title: string; shas: Set<string> }>();
  for (const row of rows) {
    const plan = plans.get(row.id) ?? { title: row.title, shas: new Set<string>() };
    if (row.blob_sha) plan.shas.add(row.blob_sha);
    plans.set(row.id, plan);
  }
  return [...plans.entries()].map(([id, plan]) => ({
    id,
    title: plan.title,
    bytes: [...plan.shas].reduce((sum, sha) => sum + blobBytes(workspace, sha), 0),
  }));
}

function blobBytes(workspace: string, sha: string): number {
  try {
    const [folder, dir, name] = blobParts(sha);
    return statSync(join(workspace, folder, dir, name)).size;
  } catch {
    return 0;
  }
}

/**
 * Settings, Data, Free up space: deletes what nothing uses any more, then the files nothing names. That covers the
 * hidden copies a plan file import made for a plan deleted before plan deletion took them along, removed library
 * sources nothing cites, extraction results of finished imports, and files a crash or a failed write left behind. A
 * file stays while a source, attachment, document version, whiteboard or a job that may still run names it. An
 * automatic backup copying meanwhile notices that a file it needed is gone, stops with `backup-changed` and runs again
 * later. Everything here is synchronous, so no other core code runs between the checks and the removals.
 */
export function freeUpSpace(db: Database.Database, workspace: string): { bytes: number } {
  const listed = chatListedSources(db);
  const unplanned = (where: string) =>
    (
      db
        .prepare(
          `SELECT id FROM sources WHERE ${where} AND id NOT IN (SELECT source_id FROM plan_sources) ORDER BY id`,
        )
        .all() as Array<{ id: string }>
    )
      .map((row) => row.id)
      .filter((id) => !listed.has(id));
  db.transaction(() => {
    // Only a plan file import makes a hidden smartbook, so its book goes with it.
    deleteHiddenSources(db, unplanned("library = 0"), { books: true });
    deleteRemovedSources(db, unplanned("status = 'removed'"));
  })();
  return { bytes: workspace ? sweepBlobs(db, workspace) : 0 };
}

/** Blob names `putBlob` writes (`<sha>`, `<sha>.json`), and its temporary names before the rename. */
const BLOB_NAME = /^([a-f0-9]{64})(\.json)?$/;
const TEMPORARY_NAME = /^\.([a-f0-9]{64})(\.json)?\.[0-9a-f-]{36}\.tmp$/;

/** Removes every blob file and leftover temporary file that nothing names, and returns the bytes freed. */
function sweepBlobs(db: Database.Database, workspace: string): number {
  const root = join(workspace, "blobs");
  if (!existsSync(root)) return 0;
  const inUse = blobUse(db);
  let freed = 0;
  for (const folder of readdirSync(root)) {
    if (!/^[a-f0-9]{2}$/.test(folder)) continue;
    const dir = join(root, folder);
    if (!lstatSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const blob = BLOB_NAME.exec(name);
      const sha = (blob ?? TEMPORARY_NAME.exec(name))?.[1];
      // A file in the wrong folder is not one putBlob wrote. A blob in use keeps its metadata too.
      if (!sha || !sha.startsWith(folder) || (blob && inUse(sha))) continue;
      const path = join(dir, name);
      const info = lstatSync(path);
      if (!info.isFile()) continue;
      try {
        rmSync(path);
        freed += info.size;
      } catch {
        /* Ceiling: a locked file (Windows) stays until the next run. */
      }
    }
  }
  return freed;
}
