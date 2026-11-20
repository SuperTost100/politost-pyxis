import { IpcError } from "../../shared/ipc";
import { isRetiredProvider } from "../../shared/limits";
import type Database from "better-sqlite3";
import { nearestEffort, studentEffort } from "../../shared/effort";
import { planAuto, type AutoFeature, type AutoProvider } from "./auto";
import { isBenched, isModelBenched } from "./bench";
import { effortsOf, runsAs, unfoldVariant, wasReported } from "./efforts";
import { automaticEffortOn, isForeignModel, isOwnModel } from "./model-roles";
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
  const stored0 = own ?? readRow(db, "default");
  if (!stored0)
    throw new IpcError("engine-missing", "engines.errors.engine-missing");
  // A row an earlier build saved with a level folded into the model id (`gemini-4-neon-xhigh`) is the model at that level.
  const unfolded = unfoldVariant(stored0.provider, stored0.model);
  const row = unfolded ? { ...stored0, model: unfolded.model, effort: unfolded.effort } : stored0;
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
      : automaticEffortOn(selection.provider, feature, listed);
  // A level the tool lists as a model of its own (`gemini-4-neon-xhigh`) runs as that model, with no effort flag.
  const model = runsAs(selection.provider, selection.model, effort);
  return {
    ...selection,
    model,
    ...(effort && model === selection.model ? { effort } : {}),
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

/** Whether the automatic choice has made a plan since Pyxis started: before that the list above is empty by default. */
let planned = false;
const waitingForPlan = new Set<() => void>();

export function rememberReady(providers: AutoProvider[]): void {
  ready = providers;
  planned = true;
  for (const resume of [...waitingForPlan]) resume();
}

/**
 * How long a job that names a tool Pyxis no longer offers waits for the first plan. The plan reads every tool's model
 * list, which takes seconds, and a plan that cannot read any list never comes, so the wait is bounded.
 * shortcut: a fixed bound; replace it with the plan's own failure signal if autoConfigure ever reports one.
 */
export const FIRST_PLAN_WAIT_MS = 60_000;

/**
 * Resolves once the first plan exists, or after `FIRST_PLAN_WAIT_MS`. A job saved by an earlier build that names a
 * retired tool is moved to the automatic choice, which needs the plan: the runner starts before it, so such a job waits
 * here instead of failing with `engine-missing` on the first launch after an update. A cancelled job stops waiting at
 * once: the promise rejects with the signal's reason, and the timer and the waiter are removed.
 */
export function afterFirstPlan(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (planned) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      waitingForPlan.delete(resume);
      signal?.removeEventListener("abort", cancelled);
    };
    const resume = () => {
      done();
      resolve();
    };
    const cancelled = () => {
      done();
      reject(signal!.reason);
    };
    const timer = setTimeout(resume, FIRST_PLAN_WAIT_MS);
    waitingForPlan.add(resume);
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

/** Tests: no plan has been made yet. */
export function forgetFirstPlan(): void {
  planned = false;
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
 * A planner's choice as the tool runs it: a level the tool lists as a model of its own (`gemini-4-neon-xhigh`) runs as
 * that model with no effort flag, the same switch `selectionFor` makes for a stored row.
 */
function runnable<T extends { provider: string; model: string; effort?: string }>(choice: T): T {
  const model = runsAs(choice.provider, choice.model, choice.effort);
  if (model === choice.model) return choice;
  const { effort: _effort, ...rest } = choice;
  return { ...rest, model } as unknown as T;
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
  return choice ? runnable({ ...choice, provider: choice.provider as ProviderId }) : undefined;
}

/**
 * A model that this tool must not run: any model of a tool Pyxis no longer offers, one the tool reported that is not
 * its maker's (a Composer model), or one that belongs to another tool's maker (a Claude model on Antigravity). An id
 * nobody knows is not ruled out here.
 */
export function offLimits(provider: string, model: string): boolean {
  return (
    isRetiredProvider(provider) ||
    (!isOwnModel(provider, model) &&
      (wasReported(provider, model) || isForeignModel(provider, model)))
  );
}

/**
 * The selection a call runs with. One that names a model its tool may not run, as a job saved by an earlier build can,
 * becomes the automatic choice for its task (the default task for a pinned one), on the same tool when it is ready and
 * on the next one otherwise. With no tool ready to take it the call stops, so the tool is never asked for that model.
 */
export function currentSelection<T extends { provider: string; model: string; chosenFor?: string }>(selection: T): T {
  // A job an earlier build saved can hold a level folded into the model id (`gemini-4-neon-xhigh`): it resumes as that
  // model at that effort, which is what cli-funnel 1.0 accepts (or, for a tool that still lists the level as a model, as
  // that id with no effort flag).
  const unfolded = unfoldVariant(selection.provider, selection.model);
  if (unfolded) selection = runnable({ ...selection, ...unfolded });
  if (!offLimits(selection.provider, selection.model)) return selection;
  const feature = selection.chosenFor ?? "default";
  // The same tool first, so a job keeps its tool whatever order the student put their tools in; the plan for all the
  // ready tools only when that one cannot serve the task.
  const choice =
    selectionOn(selection.provider, feature) ??
    fallbackSelection({ provider: selection.provider, chosenFor: feature }, "model");
  if (!choice) throw new IpcError("engine-missing", "engines.errors.engine-missing");
  return { ...choice, chosenFor: feature } as unknown as T;
}

/**
 * The ids of a tool's models in the catalog the automatic choice plans from, without the ones its plan refused, so a
 * screen that names the model of a role says what the planner runs. Undefined for a tool the planner does not hold: one
 * still to connect, turned off or not yet confirmed.
 */
export function plannedModels(provider: string): string[] | undefined {
  const there = ready.find((candidate) => candidate.id === provider);
  return there && withoutRefusedModels([there])[0]!.models.map((model) => model.id);
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
    ? runnable({ ...choice, provider: choice.provider as ProviderId })
    : undefined;
}

/** The providers with only the models their subscription has not refused today. */
export function withoutRefusedModels(providers: AutoProvider[]): AutoProvider[] {
  return providers.map((provider) => ({
    ...provider,
    models: provider.models.filter((model) => !isModelBenched(provider.id, model.id)),
  }));
}
