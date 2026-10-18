import { nearestEffort } from "../../shared/effort";

/**
 * The efforts each model lists, as last seen. Model lists are fetched
 * asynchronously (engine screen, automatic choice), while `selectionFor` has
 * to answer at once, so it reads what those fetches left here.
 */
const seen = new Map<string, Map<string, string[]>>();

export function rememberModels(
  provider: string,
  models: ReadonlyArray<{ id: string; efforts: ReadonlyArray<{ id: string }> }>,
): void {
  seen.set(
    provider,
    new Map(models.map((model) => [model.id, model.efforts.map((e) => e.id)])),
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
}
