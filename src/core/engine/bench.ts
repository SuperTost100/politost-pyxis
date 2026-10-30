/**
 * Engines an automatic task skips for now: one that hit a usage limit, in memory until the limit resets, and one whose
 * sign-in a provider refused. A refused sign-in also takes the engine out of the automatic plan and shows it signed out
 * in Settings, because the CLI's own check can go on saying "signed in" (Codex does after its token stops working). It
 * is kept in the workspace when a store is configured, so a restart does not send lessons back to it.
 */
const limited = new Map<string, number>();
/** Refused sign-ins, each with the moment on `engineClock` it was marked. */
const signedOut = new Map<string, number>();
let clock = 0;

/**
 * A counter that orders what Pyxis learns about sign-ins: a refusal, and a scan that sees a CLI signed out. A scan's
 * signed-out report undoes a refusal only when it came later, so an older report cannot clear a newer refusal.
 */
export function engineClock(): number {
  clock += 1;
  return clock;
}

/** When the refusal of this engine was marked, on `engineClock`, or undefined when it is not refused. */
export function signedOutSince(provider: string): number | undefined {
  return signedOut.get(provider);
}

/** Where refused sign-ins are kept between launches. */
export type SignOutStore = {
  load(): string[];
  save(provider: string, signedOut: boolean): void;
};
let store: SignOutStore | undefined;
let onChange: ((provider: string) => void) | undefined;

/** Reads the refused sign-ins kept in `next`. `listener` hears every engine that is marked or cleared. */
export function configureSignOuts(
  next: SignOutStore | undefined,
  listener?: (provider: string) => void,
): void {
  store = next;
  onChange = listener;
  signedOut.clear();
  for (const provider of next?.load() ?? []) signedOut.set(provider, engineClock());
}

/** How long a limit without a reset time keeps an engine out. */
export const DEFAULT_LIMIT_MS = 30 * 60_000;

export function benchEngine(
  provider: string,
  reason: "limit" | "signed-out",
  limit?: { resetAt?: string; retryAfterMs?: number },
  now = Date.now(),
): void {
  if (reason === "signed-out") {
    markSignedOut(provider);
    return;
  }
  const reset = limit?.resetAt ? Date.parse(limit.resetAt) : NaN;
  const until = Number.isFinite(reset)
    ? reset
    : now + (limit?.retryAfterMs ?? DEFAULT_LIMIT_MS);
  limited.set(provider, until);
}

/** The provider refused the engine's sign-in or key: it stays out until the student signs in again. */
export function markSignedOut(provider: string): void {
  const known = signedOut.has(provider);
  // A new refusal moves the mark forward, so only a signed-out report after it can undo it.
  signedOut.set(provider, engineClock());
  if (known) return;
  store?.save(provider, true);
  onChange?.(provider);
}

export function isSignedOut(provider: string): boolean {
  return signedOut.has(provider);
}

export function isBenched(provider: string, now = Date.now()): boolean {
  if (signedOut.has(provider)) return true;
  const until = limited.get(provider);
  if (until === undefined) return false;
  if (until > now) return true;
  limited.delete(provider);
  return false;
}

/**
 * The engine is signed in again: Pyxis signed it in, a call or a test answered, a scan saw it signed out and then
 * signed in, or its key changed. A sign-out no longer keeps it out. A limit still does.
 */
export function clearSignOut(provider: string): void {
  if (!signedOut.delete(provider)) return;
  store?.save(provider, false);
  onChange?.(provider);
}

/**
 * A call that began at `startedAt` (on `engineClock`) answered: the engine is signed in again, unless a call refused
 * after this one began, which is newer news about the sign-in than this answer.
 */
export function clearSignOutBefore(provider: string, startedAt: number): void {
  const refusedAt = signedOut.get(provider);
  if (refusedAt !== undefined && refusedAt < startedAt) clearSignOut(provider);
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
  limited.clear();
  signedOut.clear();
  refusedModels.clear();
  store = undefined;
  onChange = undefined;
}
