import { effortScale, nearestEffort } from "../../shared/effort";
import { displayModelName } from "../../shared/model-names";
import { variantsOf } from "./effort-variants";
import { lowEffortOn } from "./model-roles";

/**
 * The efforts each model lists, as last seen. Model lists are fetched
 * asynchronously (engine screen, automatic choice), while `selectionFor` has
 * to answer at once, so it reads what those fetches left here.
 */
const seen = new Map<string, Map<string, string[]>>();
/** The engine's own name for each model it listed, such as "Codex 5.3" for `gpt-5.3-codex`. */
const names = new Map<string, Map<string, string>>();
/** Every id a tool reported at its last listing, the maker's own or not. */
const reported = new Map<string, Set<string>>();

/** The effort variants each tool listed as models of their own, by model and level (see `variantsOf`). */
const variants = new Map<string, Map<string, string>>();

/** The id a model runs as at an effort level, when the tool lists that level as a model of its own; else the model. */
export function runsAs(provider: string, model: string, effort: string | undefined): string {
  return (effort && variants.get(provider)?.get(`${model}|${effort}`)) || model;
}

/**
 * A saved model id that an earlier build ran as a level of another model, as the model and the level: `gemini-4-neon-xhigh`
 * is `gemini-4-neon` at `xhigh`. Only `xhigh` was ever listed as a model of its own (the other levels were grouped). A
 * listing that is read and offers no such model with that level leaves the id alone; before any listing is read the id
 * is unfolded anyway, since a job saved by the previous build may resume first.
 */
export function unfoldVariant(provider: string, model: string): { model: string; effort: string } | undefined {
  if (provider !== "antigravity") return undefined;
  const match = /^(.+)-xhigh$/.exec(model);
  if (!match) return undefined;
  const base = match[1]!;
  const listed = seen.get(provider);
  if (listed && listed.size > 0) {
    const levels = listed.get(base);
    if (!levels || !(levels.includes("xhigh") || variants.get(provider)?.has(`${base}|xhigh`))) return undefined;
  }
  return { model: base, effort: "xhigh" };
}

/** Whether the tool's last listing held this id, even though it is not one of its maker's models. */
export function wasReported(provider: string, model: string): boolean {
  return reported.get(provider)?.has(model) ?? false;
}

/**
 * Remembers the models a tool offers, with their efforts and names. Callers pass the maker's own models, so the screens
 * never read another company's. `reportedIds` are all the ids the tool listed, own or not, which the listing itself passes.
 */
export function rememberModels(
  provider: string,
  models: ReadonlyArray<{
    id: string;
    name?: string;
    efforts: ReadonlyArray<{ id: string }>;
  }>,
  reportedIds?: ReadonlyArray<{ id: string; efforts: ReadonlyArray<{ id: string }> }>,
): void {
  if (reportedIds) {
    reported.set(provider, new Set(reportedIds.map((model) => model.id)));
    variants.set(provider, variantsOf(reportedIds));
  }
  seen.set(
    provider,
    new Map(models.map((model) => [model.id, model.efforts.map((e) => e.id)])),
  );
  const next = new Map(
    models.flatMap((model) =>
      model.name?.trim() ? [[model.id, displayModelName(model.id, model.name)] as const] : [],
    ),
  );
  const before = names.get(provider);
  names.set(provider, next);
  const changed =
    !before ||
    before.size !== next.size ||
    [...next].some(([id, name]) => before.get(id) !== name);
  // Names that are gone matter too: the screens must stop showing them. A list that never had names changes nothing.
  if (changed && (next.size > 0 || (before?.size ?? 0) > 0)) onNames?.(provider);
}

let onNames: ((provider: string) => void) | undefined;

/**
 * `listener` hears every engine whose model names changed. A test or a model listing reads a list outside the automatic
 * choice, so without this the screens would keep showing readable ids for models core can now name.
 */
export function setModelNamesListener(
  listener: ((provider: string) => void) | undefined,
): void {
  onNames = listener;
}

/** The name a student reads for a model: the engine's own when its list was read, else the id made readable. */
export function modelName(provider: string, model: string): string {
  return displayModelName(model, names.get(provider)?.get(model));
}

/** Every model name read so far, by engine, for the screens that show a model. */
export function modelNames(): Record<string, Record<string, string>> {
  return Object.fromEntries(
    [...names].map(([provider, models]) => [provider, Object.fromEntries(models)]),
  );
}

/** The efforts a model lists, or `undefined` when its list has not been read yet. */
export function effortsOf(
  provider: string,
  model: string,
): string[] | undefined {
  return seen.get(provider)?.get(model);
}

/**
 * The effort to send with a request the student asked for at `wanted`. Once the model's list has been read, the wanted
 * level when the model lists it, otherwise the nearest it lists, and none for a model that lists none. Before the list
 * is read the request is left as asked.
 */
export function resolveEffort(
  provider: string,
  model: string,
  wanted: string | undefined,
): string | undefined {
  if (!wanted) return undefined;
  const listed = effortsOf(provider, model);
  return listed ? nearestEffort(wanted, listed) : wanted;
}

/**
 * The selection for `call` (`outline`, `quiz`) at the lowest effort its model lists when the model file says that tool
 * runs that call so (`lowEffortOn()`), else as it is. These are calls that reshape what they are given and whose reply
 * code checks. Measured on Gemini 3.8 Flash at medium, the thinking took 37 of the 45 seconds of an outline, and 4,900
 * of its 5,100 output tokens; at low the same call took 8 seconds. A model that lists no level runs with none.
 */
export function atLowEffort<T extends { provider: string; model: string; effort?: string }>(selection: T, call: string): T {
  if (!lowEffortOn(selection.provider, call)) return selection;
  // A level carried by the model id (`gemini-4-neon-xhigh`) is the model at that level, which is replaced here.
  const unfolded = unfoldVariant(selection.provider, selection.model);
  const model = unfolded?.model ?? selection.model;
  // A selection with no effort of its own runs at the tool's default, which can be its highest: it is lowered when the
  // model lists levels, and left when it is not known to list any.
  if (!unfolded && !selection.effort && !effortsOf(selection.provider, model)?.length) return selection;
  // The lowest level the model lists (`minimal` below `low` where it has one), never `none`; `low` while the list is unread.
  const listed = effortsOf(selection.provider, model);
  const effort = listed ? lowestEffort(listed) : "low";
  const runs = runsAs(selection.provider, model, effort);
  const { effort: _stored, ...rest } = selection;
  return { ...rest, model: runs, ...(effort && runs === model ? { effort } : {}) } as T;
}

/** The lightest of `listed` on the effort scale, leaving out `none` and ids the scale does not know. */
function lowestEffort(listed: readonly string[]): string | undefined {
  const rank = (id: string) => effortScale.indexOf(id as (typeof effortScale)[number]);
  return listed.filter((id) => rank(id) > 0).sort((a, b) => rank(a) - rank(b))[0];
}

export function forgetModels(): void {
  seen.clear();
  names.clear();
  reported.clear();
  variants.clear();
}
