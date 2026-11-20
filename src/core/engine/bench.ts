/**
 * Engines an automatic task skips for now: one that hit a usage limit, until the limit resets, one whose sign-in a
 * provider refused, and one whose program was gone when a call started it. A refused sign-in also takes the engine out
 * of the automatic plan and shows it signed out in Settings, because the CLI's own check can go on saying "signed in"
 * (Codex does after its token stops working). Limits and refused sign-ins are kept in the workspace when a store is
 * configured, so a restart does not send lessons back to an engine known to be out.
 */
const limited = new Map<string, { until: number; since: number; guessed: boolean }>();
/** Engines whose program was not found when a call started it, each with the moment on `engineClock` it was marked. */
const missing = new Map<string, number>();
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

/** Where refused sign-ins and usage limits are kept between launches. */
export type SignOutStore = {
  load(): string[];
  save(provider: string, signedOut: boolean): void;
  /** The limits still kept, each with the time it resets. */
  loadLimits(): Array<{ provider: string; until: number }>;
  /** Keeps a limit until `until`, or forgets it when `until` is null. */
  saveLimit(provider: string, until: number | null): void;
};
/**
 * What changed about an engine: its sign-in or its program, which move the automatic plan, or a usage limit, which
 * only changes what Settings says about it.
 */
export type BenchChange = "sign-in" | "missing" | "limit";
let store: SignOutStore | undefined;
/** Who follows an engine's usage limit: told when it is marked, moved to another time or cleared (`until` undefined). */
const limitListeners = new Set<(provider: string, until: number | undefined) => void>();

/** Calls `listener` whenever an engine's usage limit is marked, moved or cleared. Returns how to stop. */
export function onLimitChange(listener: (provider: string, until: number | undefined) => void): () => void {
  limitListeners.add(listener);
  return () => void limitListeners.delete(listener);
}

function limitChanged(provider: string, until: number | undefined): void {
  for (const listener of [...limitListeners]) listener(provider, until);
}
let onChange: ((provider: string, change: BenchChange) => void) | undefined;

/**
 * Reads the refused sign-ins and the usage limits kept in `next`. A limit whose reset time has passed is forgotten.
 * `listener` hears every engine that is marked or cleared.
 */
export function configureSignOuts(
  next: SignOutStore | undefined,
  listener?: (provider: string, change: BenchChange) => void,
  now = Date.now(),
): void {
  store = next;
  onChange = listener;
  signedOut.clear();
  limited.clear();
  for (const provider of next?.load() ?? []) signedOut.set(provider, engineClock());
  for (const { provider, until } of next?.loadLimits() ?? []) {
    if (until > now) limited.set(provider, { until, since: engineClock(), guessed: false });
    else next?.saveLimit(provider, null);
  }
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
  // Without a reset time the wait is Pyxis's own guess, which the engine's usage report may replace (`limitIsGuess`).
  limited.set(provider, {
    until,
    since: engineClock(),
    guessed: !Number.isFinite(reset) && limit?.retryAfterMs === undefined,
  });
  store?.saveLimit(provider, until);
  onChange?.(provider, "limit");
  limitChanged(provider, until);
}

/** When this engine's usage limit resets, in milliseconds since the epoch, or undefined while it has requests left. */
export function limitedUntil(provider: string, now = Date.now()): number | undefined {
  const limit = limited.get(provider);
  if (!limit) return undefined;
  if (limit.until > now) return limit.until;
  forgetLimit(provider);
  return undefined;
}

/** True while the engine is out on a wait Pyxis guessed, because its limit came without a reset time. */
export function limitIsGuess(provider: string): boolean {
  return limited.get(provider)?.guessed === true;
}

/**
 * Names the engine's limit while its wait is a guess: the moment on `engineClock` it was hit, or undefined when it has
 * no limit or one with its own time. A question about the limit takes this before it is asked and gives it back to
 * `refineLimit`, which then knows whether the limit is still that one.
 */
export function guessedLimitMark(provider: string): number | undefined {
  const limit = limited.get(provider);
  return limit?.guessed ? limit.since : undefined;
}

/**
 * Replaces the guessed wait of the limit named by `mark` with the time the engine's usage report gave. A limit that was
 * cleared or hit again since is another one, and keeps what it has. The moment the limit was hit stays, so a test that
 * began after it still clears it.
 */
export function refineLimit(provider: string, mark: number, until: number): void {
  const limit = limited.get(provider);
  if (!limit?.guessed || limit.since !== mark) return;
  limited.set(provider, { until, since: limit.since, guessed: false });
  store?.saveLimit(provider, until);
  onChange?.(provider, "limit");
  limitChanged(provider, until);
}

function forgetLimit(provider: string): boolean {
  if (!limited.delete(provider)) return false;
  store?.saveLimit(provider, null);
  limitChanged(provider, undefined);
  return true;
}

/**
 * A call that began at `startedAt` (on `engineClock`) answered, so the engine has requests left, unless the limit was
 * hit after this call began: a call that slipped through before the last request was used says nothing about now.
 */
export function clearLimitBefore(provider: string, startedAt: number): void {
  const limit = limited.get(provider);
  if (!limit || limit.since >= startedAt) return;
  forgetLimit(provider);
  onChange?.(provider, "limit");
}

/**
 * The engine's program was not found when a call started it. It stays out until a scan that began later finds it
 * installed, and the automatic plan is worked out again without it.
 */
export function markMissing(provider: string): void {
  const known = missing.has(provider);
  missing.set(provider, engineClock());
  if (!known) onChange?.(provider, "missing");
}

/** A scan that began at `scanStarted` (on `engineClock`) found the program: the engine is back unless it went missing later. */
export function clearMissingBefore(provider: string, scanStarted: number): void {
  const since = missing.get(provider);
  if (since !== undefined && since < scanStarted) missing.delete(provider);
}

export function isMissing(provider: string): boolean {
  return missing.has(provider);
}

/** The provider refused the engine's sign-in or key: it stays out until the student signs in again. */
export function markSignedOut(provider: string): void {
  const known = signedOut.has(provider);
  // A new refusal moves the mark forward, so only a signed-out report after it can undo it.
  signedOut.set(provider, engineClock());
  if (known) return;
  store?.save(provider, true);
  onChange?.(provider, "sign-in");
}

export function isSignedOut(provider: string): boolean {
  return signedOut.has(provider);
}

export function isBenched(provider: string, now = Date.now()): boolean {
  if (signedOut.has(provider) || missing.has(provider)) return true;
  return limitedUntil(provider, now) !== undefined;
}

/**
 * The engine is signed in again: Pyxis signed it in, a call or a test answered, a scan saw it signed out and then
 * signed in, or its key changed. A sign-out no longer keeps it out. A limit still does.
 */
export function clearSignOut(provider: string): void {
  if (!signedOut.delete(provider)) return;
  store?.save(provider, false);
  onChange?.(provider, "sign-in");
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

/** How long a model the subscription refused stays out. Some plans count usage by the week. */
export const MODEL_REFUSED_MS = 24 * 60 * 60_000;

const modelKey = (provider: string, model: string) => `${provider}\n${model}`;

let onModelRefused: ((provider: string) => void) | undefined;

/** `listener` hears every engine whose subscription refused one of its models, so the automatic plan can move. */
export function setModelRefusalListener(
  listener: ((provider: string) => void) | undefined,
): void {
  onModelRefused = listener;
}

/** The subscription refused this model: the automatic choice leaves it out until the time is up. */
export function benchModel(
  provider: string,
  model: string,
  now = Date.now(),
): void {
  const until = now + MODEL_REFUSED_MS;
  refusedModels.set(modelKey(provider, model), until);
  onModelRefused?.(provider);
}

/** The models of this provider its subscription refused, while they stay out. */
export function refusedModelsOf(provider: string, now = Date.now()): string[] {
  const prefix = modelKey(provider, "");
  return [...refusedModels.keys()]
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter((model) => isModelBenched(provider, model, now));
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
  limitListeners.clear();
  signedOut.clear();
  missing.clear();
  refusedModels.clear();
  onModelRefused = undefined;
  store = undefined;
  onChange = undefined;
}
