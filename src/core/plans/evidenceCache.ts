import type Database from "better-sqlite3";

/**
 * Per-plan values derived from study evidence, kept until a write could change them. Temporary triggers on the
 * connection report every such write, so no write path (imports, cascades, plain SQL in tests) can leave a stale entry.
 */
type Watch = {
  entries: Map<string, unknown>;
  listeners: Set<() => void>;
};

const watched = new WeakMap<Database.Database, Watch>();

const CHANGED = "pyxis_evidence_changed";

/** The writes that can change a plan's mastery, and the plan each row belongs to. A NULL plan clears every plan. */
const SOURCES: Array<{ table: string; columns?: string; plan: string }> = [
  { table: "learning_events", plan: "#.plan_id" },
  {
    table: "card_reviews",
    plan: "(SELECT plan_id FROM cards WHERE id = #.card_id)",
  },
  {
    table: "cards",
    columns: "plan_id, topic_id, suspended, removed, created_at",
    plan: "#.plan_id",
  },
  // Question kinds and old simulation answers are read from items and attempts.
  { table: "items", columns: "plan_id, kind, body_json", plan: "#.plan_id" },
  {
    table: "attempts",
    columns: "plan_id, item_id, submitted_at",
    plan: "#.plan_id",
  },
  {
    table: "attempt_answers",
    plan: "(SELECT plan_id FROM attempts WHERE id = #.attempt_id)",
  },
  // A flag can hide evidence in any plan.
  { table: "flags", plan: "NULL" },
];

function watch(db: Database.Database): Watch | undefined {
  const known = watched.get(db);
  if (known) return known;
  // Triggers created inside a transaction would vanish with a rollback and leave the cache unwatched.
  if (db.inTransaction || db.readonly || !db.open) return undefined;
  const state: Watch = { entries: new Map(), listeners: new Set() };
  db.function(CHANGED, (planId: unknown) => {
    if (typeof planId === "string") state.entries.delete(planId);
    else state.entries.clear();
    for (const listener of state.listeners) listener();
    return null;
  });
  const call = (row: "new" | "old", plan: string) =>
    `SELECT ${CHANGED}(${plan.replaceAll("#", row)});`;
  db.exec(
    SOURCES.flatMap(({ table, columns, plan }) => [
      `CREATE TEMP TRIGGER evidence_${table}_insert AFTER INSERT ON ${table} BEGIN ${call("new", plan)} END;`,
      `CREATE TEMP TRIGGER evidence_${table}_update AFTER UPDATE${columns ? ` OF ${columns}` : ""} ON ${table} BEGIN ${call("old", plan)} ${call("new", plan)} END;`,
      `CREATE TEMP TRIGGER evidence_${table}_delete AFTER DELETE ON ${table} BEGIN ${call("old", plan)} END;`,
    ]).join("\n"),
  );
  watched.set(db, state);
  return state;
}

/** The cached value for this plan, or `read()` stored for next time. */
export function cachedEvidence<T>(
  db: Database.Database,
  planId: string,
  read: () => T,
): T {
  const state = watch(db);
  if (!state) return read();
  if (state.entries.has(planId)) return state.entries.get(planId) as T;
  const value = read();
  // Inside a transaction the read can see writes that are rolled back later; only committed state is kept.
  if (!db.inTransaction) state.entries.set(planId, value);
  return value;
}

/** Calls `listener` after each write that can change some plan's mastery. It must not use the database. */
export function onEvidenceChanged(
  db: Database.Database,
  listener: () => void,
): void {
  watch(db)?.listeners.add(listener);
}
