import type Database from "better-sqlite3";
import { isRetiredProvider } from "../../shared/limits";
import { putSetting } from "../settings";
import type { SignOutStore } from "./bench";

const ALLOWED_KEY = "engines.allowed";
const ORDER_KEY = "engines.order";
const signOutKey = (provider: string) => `engine-signed-out:${provider}`;
const limitKey = (provider: string) => `engine-limited:${provider}`;

/**
 * The engines the student lets Pyxis use, or null for automatic: every engine that is ready, including ones signed in
 * later. Setup and Settings write it; the automatic plan and the task pickers read it.
 */
export function readAllowed(db: Database.Database): string[] | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(ALLOWED_KEY) as { value_json: string } | undefined;
  return offered(row ? JSON.parse(row.value_json) : null);
}

/**
 * A stored list of tools without the ones Pyxis no longer offers. A choice of tools that held only a retired one stays
 * a choice, now of none: the tools the student left out stay out until they enable one themselves, so nothing starts
 * to receive their material without their say. For an order the same list is no order.
 */
function offered(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((id): id is string => typeof id === "string" && !isRetiredProvider(id));
}

export function writeAllowed(
  db: Database.Database,
  allowed: readonly string[] | null,
): void {
  putSetting(db, ALLOWED_KEY, allowed ? [...new Set(allowed)] : null);
}

/** True when the student's choice lets Pyxis use this engine. The local model has its own switch and is not listed. */
export function isAllowed(
  allowed: readonly string[] | null,
  provider: string,
): boolean {
  return allowed === null || allowed.includes(provider);
}

/**
 * The order the student put their tools in, first to last, or null while they never set one: Pyxis then shares the
 * work among the ready tools as it always did. Settings writes it; the automatic plan and a failing task's next tool
 * read it.
 */
export function readOrder(db: Database.Database): string[] | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(ORDER_KEY) as { value_json: string } | undefined;
  const order = offered(row ? JSON.parse(row.value_json) : null);
  return order?.length ? order : null;
}

export function writeOrder(
  db: Database.Database,
  order: readonly string[] | null,
): void {
  putSetting(db, ORDER_KEY, order ? [...new Set(order)] : null);
}

/** Keeps refused sign-ins and usage limits in the settings table, so they outlast a restart. */
export function signOutStore(db: Database.Database): SignOutStore {
  return {
    load: () =>
      (
        db
          .prepare(
            "SELECT key FROM settings WHERE key LIKE 'engine-signed-out:%' AND value_json = 'true'",
          )
          .all() as Array<{ key: string }>
      )
        .map((row) => row.key.slice(signOutKey("").length))
        .filter((provider) => !isRetiredProvider(provider)),
    save: (provider, signedOut) => {
      if (signedOut) putSetting(db, signOutKey(provider), true);
      else db.prepare("DELETE FROM settings WHERE key = ?").run(signOutKey(provider));
    },
    loadLimits: () =>
      (
        db
          .prepare("SELECT key, value_json FROM settings WHERE key LIKE 'engine-limited:%'")
          .all() as Array<{ key: string; value_json: string }>
      ).flatMap((row) => {
        const until: unknown = JSON.parse(row.value_json);
        const provider = row.key.slice(limitKey("").length);
        return typeof until === "number" && !isRetiredProvider(provider) ? [{ provider, until }] : [];
      }),
    saveLimit: (provider, until) => {
      if (until === null) db.prepare("DELETE FROM settings WHERE key = ?").run(limitKey(provider));
      else putSetting(db, limitKey(provider), until);
    },
  };
}
