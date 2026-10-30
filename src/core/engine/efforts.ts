import { nearestEffort } from "../../shared/effort";
import { readableModel } from "../../shared/model-names";

/**
 * The efforts each model lists, as last seen. Model lists are fetched
 * asynchronously (engine screen, automatic choice), while `selectionFor` has
 * to answer at once, so it reads what those fetches left here.
 */
const seen = new Map<string, Map<string, string[]>>();
/** The engine's own name for each model it listed, such as "Codex 5.3" for `gpt-5.3-codex`. */
const names = new Map<string, Map<string, string>>();

export function rememberModels(
  provider: string,
  models: ReadonlyArray<{
    id: string;
    name?: string;
    efforts: ReadonlyArray<{ id: string }>;
  }>,
): void {
  seen.set(
    provider,
    new Map(models.map((model) => [model.id, model.efforts.map((e) => e.id)])),
  );
  const next = new Map(
    models.flatMap((model) =>
      model.name?.trim() ? [[model.id, model.name.trim()] as const] : [],
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
  return names.get(provider)?.get(model) ?? readableModel(model);
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

export function forgetModels(): void {
  seen.clear();
  names.clear();
}
