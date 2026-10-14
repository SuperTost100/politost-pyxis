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

export function forgetModels(): void {
  seen.clear();
}
