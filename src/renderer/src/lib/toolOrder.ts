import { daysBetween } from "../../../shared/local-day";
import type { RequestOutput } from "../../../shared/ipc";

type Tool = RequestOutput<"engines.overview">[number];

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
 * The tools Pyxis may use after `id` is turned off or on again. `ready` are the tools that work now: the connected
 * ones and each API provider with a saved key. Null means every tool, also one connected later: turning back on the
 * last of the ready tools that was off returns to it. An empty answer is refused, because one tool has to stay in use.
 */
export function toggledUse(
  allowed: readonly string[] | null,
  ready: readonly string[],
  id: string,
  use: boolean,
): string[] | null | undefined {
  const current = allowed ?? ready;
  const next = use
    ? [...new Set([...current, id])]
    : current.filter((item) => item !== id);
  if (!ready.some((item) => next.includes(item))) return undefined;
  return ready.every((item) => next.includes(item)) ? null : next;
}

/** How to say when a tool has requests again: later today, tomorrow, or on another day. */
export function limitWhen(
  until: number,
  now: number,
): "today" | "tomorrow" | "later" {
  const days = daysBetween(now, until);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : "later";
}

/** When each tool that is out of requests has them again, in ms since the epoch. A tool with requests left is not in it. */
export function limitsOf(
  rows: readonly Pick<Tool, "id" | "limitedUntil">[],
  now: number,
): Map<string, number> {
  return new Map(
    rows.flatMap((row) =>
      row.limitedUntil && row.limitedUntil > now
        ? [[row.id, row.limitedUntil] as const]
        : [],
    ),
  );
}

/**
 * The tool a stopped job can go on with: the first connected tool of the student's order, other than `failed`, that is
 * in use and has requests left. Without an order, the tools in the order Pyxis found them.
 */
export function nextTool(
  rows: readonly Tool[],
  order: readonly string[] | null,
  failed: string | undefined,
  now: number,
): Tool | undefined {
  return shownOrder(rows.filter(isConnected), order).find(
    (row) =>
      row.id !== failed &&
      row.allowed &&
      !(row.limitedUntil && row.limitedUntil > now),
  );
}
