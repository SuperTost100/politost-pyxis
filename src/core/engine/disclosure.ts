import type Database from "better-sqlite3";

/** A provider must be acknowledged before a model receives workspace content. */
export function createDisclosure(
  db: Database.Database,
  notify: (provider: string, pending: boolean) => void,
) {
  const waiters = new Map<string, Set<(error?: unknown) => void>>();
  const acknowledged = (provider: string) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM settings WHERE key = ? AND value_json = 'true'")
        .get(`engine-disclosure:${provider}`),
    );
  return {
    /** Providers with a live waiter, for a renderer that missed the broadcast. */
    pending: () => [...waiters.keys()],
    acknowledge(provider: string) {
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, 'true', ?)",
      ).run(`engine-disclosure:${provider}`, Date.now());
      for (const finish of [...(waiters.get(provider) ?? [])]) finish();
    },
    cancel(provider: string) {
      for (const finish of [...(waiters.get(provider) ?? [])])
        finish(new Error("engine-disclosure-cancelled"));
    },
    async ensure(provider: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (acknowledged(provider)) return;
      await new Promise<void>((resolve, reject) => {
        const first = !waiters.has(provider);
        const listeners =
          waiters.get(provider) ?? new Set<(error?: unknown) => void>();
        waiters.set(provider, listeners);
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          listeners.delete(finish);
          if (!listeners.size) {
            waiters.delete(provider);
            notify(provider, false);
          }
          if (error !== undefined) reject(error);
          else resolve();
        };
        const abort = () =>
          finish(signal?.reason ?? new Error("engine-disclosure-cancelled"));
        const timer = setTimeout(
          () => finish(new Error("engine-disclosure-timeout")),
          300000,
        );
        listeners.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
        if (first) notify(provider, true);
      });
    },
  };
}
