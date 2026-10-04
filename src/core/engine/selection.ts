import { IpcError } from "../../shared/ipc";
import type Database from "better-sqlite3";
import type { ProviderId } from "./funnel";

export type StoredSelection = {
  provider: ProviderId;
  model: string;
  effort?: string;
  fast?: boolean;
};

export function selectionFor(
  db: Database.Database,
  feature: string,
): StoredSelection {
  const row = db
    .prepare(`SELECT selection_json FROM feature_engines WHERE feature = ?`)
    .get(feature) as { selection_json: string } | undefined;
  if (row) return JSON.parse(row.selection_json) as StoredSelection;
  if (feature !== "default") return selectionFor(db, "default");
  throw new IpcError("engine-missing", "engines.errors.engine-missing");
}
