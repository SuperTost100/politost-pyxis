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

/** Tests start from a clean slate. */
export function clearBench(): void {
  benched.clear();
}
