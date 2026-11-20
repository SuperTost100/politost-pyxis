/**
 * The oldest Antigravity program (`agy`) cli-funnel 1.0 can run: its default transport is ACP, which `agy` serves from 1.5.0.
 * An older one is not usable at all, because Pyxis does not run the one-process-per-turn transport it replaced.
 */
export const AGY_MIN_VERSION = "1.5.0";

const numbers = (version: string) => (/\d+(?:\.\d+)*/.exec(version)?.[0] ?? "").split(".").filter(Boolean).map(Number);

/** True when the installed program of this provider is one cli-funnel 1.0 cannot run. An unknown version is not. */
export function tooOld(provider: string, version: string | undefined): boolean {
  if (provider !== "antigravity" || !version) return false;
  const have = numbers(version);
  const need = numbers(AGY_MIN_VERSION);
  if (have.length === 0 || have.some(Number.isNaN)) return false;
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    if (a !== need[i]) return a < need[i]!;
  }
  return false;
}
