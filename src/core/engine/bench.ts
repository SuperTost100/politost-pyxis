/**
 * Engines an automatic task skips for now, in memory only: one that hit a usage limit until the limit resets, one that
 * was signed out until a scan finds it signed in again or its key changes.
 */
const benched = new Map<string, number>();

/** How long a limit without a reset time keeps an engine out. */
export const DEFAULT_LIMIT_MS = 30 * 60_000;

export function benchEngine(
  provider: string,
  reason: "limit" | "signed-out",
  limit?: { resetAt?: string; retryAfterMs?: number },
  now = Date.now(),
): void {
  if (reason === "signed-out") {
    benched.set(provider, Infinity);
    return;
  }
  const reset = limit?.resetAt ? Date.parse(limit.resetAt) : NaN;
  const until = Number.isFinite(reset)
    ? reset
    : now + (limit?.retryAfterMs ?? DEFAULT_LIMIT_MS);
  benched.set(provider, until);
}

export function isBenched(provider: string, now = Date.now()): boolean {
  const until = benched.get(provider);
  if (until === undefined) return false;
  if (until > now) return true;
  benched.delete(provider);
  return false;
}

/** A scan found the engine signed in, or its key changed: a sign-out no longer keeps it out. A limit still does. */
export function clearSignOut(provider: string): void {
  if (benched.get(provider) === Infinity) benched.delete(provider);
}

/**
 * Models a subscription does not include, by provider and model. The engine's other models stay usable, and the
 * automatic choice leaves these out until the time is up or Pyxis restarts.
 */
const refusedModels = new Map<string, number>();

/** How long a model the subscription refused stays out. Plans such as Cursor's count usage by the week. */
export const MODEL_REFUSED_MS = 24 * 60 * 60_000;

const modelKey = (provider: string, model: string) => `${provider}\n${model}`;

export function benchModel(
  provider: string,
  model: string,
  now = Date.now(),
): void {
  refusedModels.set(modelKey(provider, model), now + MODEL_REFUSED_MS);
}

export function isModelBenched(
  provider: string,
  model: string,
  now = Date.now(),
): boolean {
  const key = modelKey(provider, model);
  const until = refusedModels.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  refusedModels.delete(key);
  return false;
}

/** Tests start from a clean slate. */
export function clearBench(): void {
  benched.clear();
  refusedModels.clear();
}
