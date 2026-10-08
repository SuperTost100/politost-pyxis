import type Database from "better-sqlite3";

/** Thrown, never awaited on: a task does not wait for the student to read a notice. */
export const DISCLOSURE_REQUIRED = "engine-disclosure-required";

const key = (provider: string) => `engine-disclosure:${provider}`;

/**
 * A provider must be acknowledged before a model receives workspace content. The notice is shown at setup, in
 * Settings, or once at launch, never during a task, so a task that reaches an unacknowledged provider fails at once.
 */
export function createDisclosure(db: Database.Database) {
  const isAcknowledged = (provider: string) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM settings WHERE key = ? AND value_json = 'true'")
        .get(key(provider)),
    );
  return {
    isAcknowledged,
    acknowledge(providers: readonly string[]) {
      const now = Date.now();
      const insert = db.prepare(
        "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, 'true', ?)",
      );
      db.transaction(() => {
        for (const provider of providers) insert.run(key(provider), now);
      })();
    },
    ensure(provider: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!isAcknowledged(provider)) throw new Error(DISCLOSURE_REQUIRED);
    },
  };
}
