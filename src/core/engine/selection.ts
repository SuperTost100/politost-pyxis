import { IpcError } from "../../shared/ipc";
import type Database from "better-sqlite3";
import { automaticEffort, nearestEffort, studentEffort } from "../../shared/effort";
import { planAuto, type AutoFeature, type AutoProvider } from "./auto";
import { isBenched, isModelBenched } from "./bench";
import { effortsOf } from "./efforts";
import type { ProviderId } from "./funnel";
import { LOCAL_PROVIDER, localData, readLocal } from "./local";

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
 * plans and grading) or the nearest one it has. Models that list none run
 * without an effort. This is worked out on every call, so rows saved before
 * efforts existed benefit without a migration.
 */
export function selectionFor(
  db: Database.Database,
  feature: string,
): StoredSelection {
  const own = readRow(db, feature);
  const row = own ?? readRow(db, "default");
  if (!row)
    throw new IpcError("engine-missing", "engines.errors.engine-missing");
  // The automatic choice leaves plans and grading without an engine for a local model that never passed the structured
  // check. They must not borrow the default engine when that is this model.
  if (
    !own &&
    row.provider === LOCAL_PROVIDER &&
    localData.strictFeatures.includes(feature) &&
    !readLocal(db)?.check?.structured
  )
    throw new IpcError("engine-missing", "engines.errors.engine-missing");
  // `auto` and `effortChoice` are bookkeeping for the engine screen, not part of a model turn.
  const { auto, effortChoice, effort: stored, ...selection } = row;
  const picked = studentEffort({ auto, effort: stored, effortChoice });
  // The default engine's own effort belongs to the default task, not to a task that borrows the engine.
  const inherited = own || !auto ? stored : undefined;
  const listed = effortsOf(selection.provider, selection.model);
  // Until the model's list is read, an automatic row sends only the level Pyxis worked out for the task: the student's
  // pick may be one this model does not list. A pinned row keeps what it stored.
  const effort = !listed
    ? auto
      ? inherited
      : (picked ?? inherited)
    : picked && listed.includes(picked)
      ? picked
      : automaticEffort(feature, listed);
  const chosen = { ...selection, ...(effort ? { effort } : {}) };
  if (auto) automatic.set(chosen, feature);
  return chosen;
}

/**
 * The engine for "Answer again with the strongest model": the plan task's engine, which runs on the strong tier, at
 * high effort or the nearest level its model lists. A model whose list is not read yet keeps the plan task's effort.
 * An automatic plan engine stays automatic, so a usage limit still moves the answer to another engine.
 */
export function strongestSelection(db: Database.Database): StoredSelection {
  const plan = selectionFor(db, "plan");
  const listed = effortsOf(plan.provider, plan.model);
  const { effort: planEffort, ...rest } = plan;
  const effort = listed ? nearestEffort("high", listed) : planEffort;
  const chosen = { ...rest, ...(effort ? { effort } : {}) };
  const feature = automatic.get(plan);
  if (feature) automatic.set(chosen, feature);
  return chosen;
}

/** Selections Pyxis chose itself, with their task. Only these may switch engines when theirs fails. */
const automatic = new WeakMap<object, string>();
/** The engines the last automatic choice could use, with their models. */
let ready: AutoProvider[] = [];

export function rememberReady(providers: AutoProvider[]): void {
  ready = providers;
}

/**
 * Drops the engines the student just left out from the list a failing task falls back on, before the automatic plan is
 * worked out again. The local model has its own switch and stays. Null (automatic) leaves the list as it is.
 */
export function keepAllowed(allowed: readonly string[] | null): void {
  if (allowed === null) return;
  ready = ready.filter(
    (provider) => provider.kind === "local" || allowed.includes(provider.id),
  );
}

/**
 * The engine an automatic selection switches to when its own hit a usage limit, was signed out or refused the model:
 * the choice the automatic plan makes for the same task without that engine, or without that model for a refusal. The result is not automatic itself, so a task switches
 * at most once. A selection the student pinned, or one a background job saved when it was queued, gets none.
 */
export function fallbackSelection(
  selection: object & { provider: string },
  reason?: "limit" | "signed-out" | "model",
): Omit<StoredSelection, "auto" | "effortChoice"> | undefined {
  const feature = automatic.get(selection);
  if (!feature) return undefined;
  // A refused model leaves its engine's other models usable; a limit or a sign-out takes the whole engine out.
  const choice = planAuto(
    withoutRefusedModels(
      ready.filter(
        (provider) =>
          (reason === "model" || provider.id !== selection.provider) &&
          !isBenched(provider.id),
      ),
    ),
  )[feature as AutoFeature];
  return choice
    ? { ...choice, provider: choice.provider as ProviderId }
    : undefined;
}

/** The providers with only the models their subscription has not refused today. */
export function withoutRefusedModels(providers: AutoProvider[]): AutoProvider[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.filter(
      (model) => !isModelBenched(provider.id, model.id),
    ),
  }));
}
