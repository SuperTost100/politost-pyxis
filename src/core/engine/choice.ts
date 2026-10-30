import type Database from "better-sqlite3";
import { putSetting } from "../settings";
import type { SignOutStore } from "./bench";

const ALLOWED_KEY = "engines.allowed";
const signOutKey = (provider: string) => `engine-signed-out:${provider}`;

/**
 * The engines the student lets Pyxis use, or null for automatic: every engine that is ready, including ones signed in
 * later. Setup and Settings write it; the automatic plan and the task pickers read it.
 */
export function readAllowed(db: Database.Database): string[] | null {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(ALLOWED_KEY) as { value_json: string } | undefined;
  const value: unknown = row ? JSON.parse(row.value_json) : null;
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : null;
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

/** Keeps refused sign-ins in the settings table, so they outlast a restart. */
export function signOutStore(db: Database.Database): SignOutStore {
  return {
    load: () =>
      (
        db
          .prepare(
            "SELECT key FROM settings WHERE key LIKE 'engine-signed-out:%' AND value_json = 'true'",
          )
          .all() as Array<{ key: string }>
      ).map((row) => row.key.slice(signOutKey("").length)),
    save: (provider, signedOut) => {
      if (signedOut) putSetting(db, signOutKey(provider), true);
      else db.prepare("DELETE FROM settings WHERE key = ?").run(signOutKey(provider));
    },
  };
}
