import { IpcError } from "../../shared/ipc";
import type Database from "better-sqlite3";
import { automaticEffort, studentEffort } from "../../shared/effort";
import { effortsOf } from "./efforts";
import type { ProviderId } from "./funnel";

export type StoredSelection = {
  provider: ProviderId;
  model: string;
  effort?: string;
  fast?: boolean;
  /** True when Pyxis chose this engine itself and may replace it. */
  auto?: boolean;
  /** The effort the student picked for this task. Absent means the task's own level. */
  effortChoice?: string;
};

function readRow(
  db: Database.Database,
  feature: string,
): StoredSelection | undefined {
  const row = db
    .prepare(`SELECT selection_json FROM feature_engines WHERE feature = ?`)
    .get(feature) as { selection_json: string } | undefined;
  return row ? (JSON.parse(row.selection_json) as StoredSelection) : undefined;
}

/**
 * The engine for a task, with the reasoning effort it runs at. A model that
 * lists efforts gets the student's pick when it still lists it, otherwise the
 * level the task wants (low for chat and maps, medium for lessons, high for
 * plans and grading) or the nearest one it has. Models that list none, such
 * as API providers, run without an effort. This is worked out on every call,
 * so rows saved before efforts existed benefit without a migration.
 */
export function selectionFor(
  db: Database.Database,
  feature: string,
): StoredSelection {
  const own = readRow(db, feature);
  const row = own ?? readRow(db, "default");
  if (!row)
    throw new IpcError("engine-missing", "engines.errors.engine-missing");
  // `auto` and `effortChoice` are bookkeeping for the engine screen, not part of a model turn.
  const { auto, effortChoice, effort: stored, ...selection } = row;
  const picked = studentEffort({ auto, effort: stored, effortChoice });
  // The default engine's own effort belongs to the default task, not to a task that borrows the engine.
  const inherited = own || !auto ? stored : undefined;
  const listed = selection.provider.endsWith("-api")
    ? []
    : effortsOf(selection.provider, selection.model);
  const effort = !listed
    ? (picked ?? inherited)
    : picked && listed.includes(picked)
      ? picked
      : automaticEffort(feature, listed);
  return { ...selection, ...(effort ? { effort } : {}) };
}
