import { statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { blobParts } from "../../shared/blob-path";

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
