import { IpcError } from "../../shared/ipc";
import type Database from "better-sqlite3";
import type { ProviderId } from "./funnel";

export type StoredSelection = {
  provider: ProviderId;
  model: string;
  effort?: string;
  fast?: boolean;
  /** True when Pyxis chose this engine itself and may replace it. */
  auto?: boolean;
};

export function selectionFor(
  db: Database.Database,
  feature: string,
): StoredSelection {
  const row = db
    .prepare(`SELECT selection_json FROM feature_engines WHERE feature = ?`)
    .get(feature) as { selection_json: string } | undefined;
  if (row) {
    // `auto` is bookkeeping for the engine screen, not part of a model turn.
    const { auto: _auto, ...selection } = JSON.parse(
      row.selection_json,
    ) as StoredSelection;
    return selection;
  }
  if (feature !== "default") return selectionFor(db, "default");
  throw new IpcError("engine-missing", "engines.errors.engine-missing");
}
