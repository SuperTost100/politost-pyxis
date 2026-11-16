import { IpcError } from "../../shared/ipc";
import type Database from "better-sqlite3";
import { automaticEffort, nearestEffort, studentEffort } from "../../shared/effort";
import { planAuto, type AutoFeature, type AutoProvider } from "./auto";
import { isBenched, isModelBenched, pointedModels } from "./bench";
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
  /**
   * The task Pyxis chose this engine and model for, set by `selectionFor` on an automatic choice and never stored in
   * `feature_engines`. It travels in a background job's saved parameters, so a job's call may move to another model or
   * engine like any other automatic call. A model the student pinned has none.
   */
  chosenFor?: string;
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
  return {
    ...selection,
    ...(effort ? { effort } : {}),
    ...(auto ? { chosenFor: feature } : {}),
  };
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
  return { ...rest, ...(effort ? { effort } : {}) };
}

/** The engines the last automatic choice could use, with their models. */
let ready: AutoProvider[] = [];
/** The order the student put their tools in, or null while they never set one (see `planAuto`). */
let order: readonly string[] | null = null;

export function rememberReady(providers: AutoProvider[]): void {
  ready = providers;
}

/** Jobs the student told to go on with a given tool: the job's id and the tool, until Pyxis closes. */
const chosenJobs = new Map<string, string>();

/** The student chose to go on with `provider` for this job, after the tool it ran on was out of requests. */
export function chooseJobEngine(jobId: string, provider: string): void {
  chosenJobs.set(jobId, provider);
}

/** The tool the student chose for this job, if any. */
export function jobEngine(jobId: string | undefined): string | undefined {
  return jobId ? chosenJobs.get(jobId) : undefined;
}

/**
 * The model of `provider` for a task, or undefined when that tool is not one the last automatic choice could use (not
 * signed in, turned off, out of requests). `feature` names the task whose tier picks the model; a task the student
 * pinned has none, so it takes the model of the default one.
 * shortcut: a pinned task gets the tool's mid-tier model, upgrade by recording the task in the job's params.
 */
export function selectionOn(
  provider: string,
  feature = "default",
): Omit<StoredSelection, "auto" | "effortChoice" | "chosenFor"> | undefined {
  const there = ready.find((candidate) => candidate.id === provider);
  if (!there || isBenched(provider)) return undefined;
  const choice = planAuto(withoutRefusedModels([there]), undefined, null)[feature as AutoFeature];
  return choice ? { ...choice, provider: choice.provider as ProviderId } : undefined;
}

/** The student's order, for the tool a failing task moves to. Set at launch and at once when the student changes it. */
export function rememberOrder(next: readonly string[] | null): void {
  order = next;
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

/** Why a task moves to another tool: a failure the next tool would not share. */
export type FallbackReason = "limit" | "signed-out" | "model" | "not-installed";

/**
 * The engine an automatic selection switches to when its own hit a usage limit, was signed out, was not installed or
 * refused the model:
 * the choice the automatic plan makes for the same task without that engine, or without the refused models for a
 * refusal. The result is not automatic itself. A selection the student pinned gets none.
 */
export function fallbackSelection(
  selection: { provider: string; chosenFor?: string },
  reason?: FallbackReason,
): Omit<StoredSelection, "auto" | "effortChoice" | "chosenFor"> | undefined {
  const feature = selection.chosenFor;
  if (!feature) return undefined;
  // A refused model leaves its engine's other models usable; a limit, a sign-out or a missing program takes the whole
  // engine out. With the student's order the plan gives the task to the next tool of their list.
  const choice = planAuto(
    withoutRefusedModels(
      ready.filter(
        (provider) =>
          (reason === "model" || provider.id !== selection.provider) &&
          !isBenched(provider.id),
      ),
    ),
    undefined,
    order,
  )[feature as AutoFeature];
  return choice
    ? { ...choice, provider: choice.provider as ProviderId }
    : undefined;
}

/**
 * The providers with only the models their subscription has not refused today. When a refusal pointed to a kind of
 * model ("switch to a Grok model"), only the provider's models of that kind stay, if it lists any.
 */
export function withoutRefusedModels(providers: AutoProvider[]): AutoProvider[] {
  return providers.map((provider) => {
    const open = provider.models.filter(
      (model) => !isModelBenched(provider.id, model.id),
    );
    const word = pointedModels(provider.id);
    const pointed = word
      ? open.filter((model) => model.id.toLowerCase().includes(word))
      : [];
    return { ...provider, models: pointed.length ? pointed : open };
  });
}
