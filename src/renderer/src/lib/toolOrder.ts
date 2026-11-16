import { daysBetween } from "../../../shared/local-day";

/** The fields of an `engines.overview` row that decide where a tool sits in Settings. */
type ToolRow = {
  id: string;
  kind: "cli" | "api";
  installed: boolean;
  loggedIn: boolean;
  disabled: boolean;
};

/** Signed in and usable: the tools the student can put in order. */
export function isConnected(row: ToolRow): boolean {
  return row.kind === "cli" && row.installed && row.loggedIn && !row.disabled;
}

/**
 * The connected tools as the list shows them: in the order the student saved, then any tool that order does not name
 * (one connected since) in the order Pyxis found them. Without a saved order, as Pyxis found them.
 */
export function shownOrder<T extends { id: string }>(
  connected: readonly T[],
  order: readonly string[] | null,
): T[] {
  if (!order) return [...connected];
  const place = (row: T) => order.indexOf(row.id) + 1 || order.length + 1;
  // Array.prototype.sort is stable, so the tools the order leaves out keep their sequence.
  return [...connected].sort((a, b) => place(a) - place(b));
}

/**
 * The order to save after the tool at `from` moved to `to` in the shown list. Tools the old order named that are not
 * connected now keep a place after the connected ones, so signing in again puts them back in the list, not ahead of it.
 */
export function movedOrder(
  shown: readonly string[],
  from: number,
  to: number,
  saved: readonly string[] | null,
): string[] {
  const next = [...shown];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...shown];
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return [...next, ...(saved ?? []).filter((id) => !next.includes(id))];
}

/**
 * The tools Pyxis may use after `id` is turned off or on again. `usable` are the tools the student can turn on or off
 * (every CLI of this build and each API provider with a saved key) and `ready` the ones that work now. Null means
 * every tool, also one connected later: turning the last one back on returns to it. An empty answer is refused: one
 * tool has to stay in use.
 */
export function toggledUse(
  allowed: readonly string[] | null,
  usable: readonly string[],
  ready: readonly string[],
  id: string,
  use: boolean,
): string[] | null | undefined {
  const current = allowed ?? ready;
  const next = use ? [...new Set([...current, id])] : current.filter((item) => item !== id);
  if (next.length === 0) return undefined;
  return usable.every((item) => next.includes(item)) ? null : next;
}

/** How to say when a tool has requests again: later today, tomorrow, or on another day. */
export function limitWhen(until: number, now: number): "today" | "tomorrow" | "later" {
  const days = daysBetween(now, until);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : "later";
}
