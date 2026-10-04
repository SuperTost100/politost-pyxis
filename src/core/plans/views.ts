import type Database from "better-sqlite3";
import { startAttempt } from "../study/attempt";

const materialKey = (planId: string) => `plan-material:${planId}`;
const importKey = (planId: string) => `plan-import:${planId}`;
function requirePlan(db: Database.Database, planId: string) {
  if (
    !db
      .prepare("SELECT 1 FROM plans WHERE id=? AND status!='building'")
      .get(planId)
  )
    throw new Error("plan-missing-or-building");
}
function pending(db: Database.Database, planId: string): string[] {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE key=?")
    .get(materialKey(planId)) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as string[]) : [];
}
function savePending(
  db: Database.Database,
  planId: string,
  ids: string[],
  now: number,
) {
  db.prepare(
    "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
  ).run(materialKey(planId), JSON.stringify(ids), now);
}
export function markPlanImported(
  db: Database.Database,
  planId: string,
  now: number,
) {
  db.prepare(
    "INSERT INTO settings(key,value_json,updated_at) VALUES(?,'true',?)",
  ).run(importKey(planId), now);
}
export function planOrigin(db: Database.Database, planId: string) {
  return {
    imported: !!db
      .prepare("SELECT 1 FROM settings WHERE key=? AND value_json='true'")
      .get(importKey(planId)),
    needsRebuild: pending(db, planId).length > 0,
  };
}
export function topicContent(
  db: Database.Database,
  planId: string,
  topicId: string,
) {
  const passages = db
    .prepare(
      "SELECT p.id,p.source_id,s.kind,p.locator_json,p.section_path FROM topic_passages tp JOIN passages p ON p.id=tp.passage_id LEFT JOIN sources s ON s.id=p.source_id JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=? AND t.id=? ORDER BY p.created_at,p.id",
    )
    .all(planId, topicId) as Array<{
    id: string;
    source_id: string | null;
    kind: string | null;
    locator_json: string;
    section_path: string | null;
  }>;
  const smartbook = passages.find((row) => row.kind === "smartbook");
  const chapter = smartbook
    ? (JSON.parse(smartbook.locator_json) as { chapter?: number }).chapter
    : undefined;
  const items = db
    .prepare(
      "SELECT id,kind,created_at AS createdAt FROM items WHERE plan_id=? AND topic_id=? ORDER BY created_at DESC,id",
    )
    .all(planId, topicId) as Array<{
    id: string;
    source_id: string | null;
    kind: string;
    createdAt: number;
  }>;
  return {
    sourceIds: [
      ...new Set(
        passages.flatMap((row) => (row.source_id ? [row.source_id] : [])),
      ),
    ],
    passageCount: passages.length,
    itemCount: items.length,
    firstPassageId: passages[0]?.id ?? null,
    chapter: chapter ?? null,
    items,
  };
}
export function attachPlanSources(
  db: Database.Database,
  planId: string,
  sourceIds: string[],
  now = Date.now(),
) {
  return db.transaction(() => {
    requirePlan(db, planId);
    const additions: string[] = [];
    for (const sourceId of new Set(sourceIds)) {
      const source = db
        .prepare("SELECT status FROM sources WHERE id=?")
        .get(sourceId) as { status: string } | undefined;
      if (source?.status !== "ready") throw new Error("source-not-ready");
      const info = db
        .prepare(
          "INSERT OR IGNORE INTO plan_sources(plan_id,source_id) VALUES(?,?)",
        )
        .run(planId, sourceId);
      if (info.changes) additions.push(sourceId);
    }
    savePending(
      db,
      planId,
      [...new Set([...pending(db, planId), ...additions])],
      now,
    );
    return { ok: true as const };
  })();
}
export function removePlanSource(
  db: Database.Database,
  planId: string,
  sourceId: string,
  now = Date.now(),
) {
  return db.transaction(() => {
    requirePlan(db, planId);
    const result = db
      .prepare("DELETE FROM plan_sources WHERE plan_id=? AND source_id=?")
      .run(planId, sourceId);
    if (!result.changes) throw new Error("plan-source-missing");
    db.prepare(
      "DELETE FROM topic_passages WHERE topic_id IN (SELECT id FROM topics WHERE plan_id=?) AND passage_id IN (SELECT id FROM passages WHERE source_id=?)",
    ).run(planId, sourceId);
    // Existing lessons keep their citations and review history; future generation uses the revised scope.
    savePending(
      db,
      planId,
      pending(db, planId).filter((id) => id !== sourceId),
      now,
    );
    return { ok: true as const };
  })();
}
export function finishSourceRebuild(
  db: Database.Database,
  planId: string,
  sourceIds: string[],
) {
  savePending(
    db,
    planId,
    pending(db, planId).filter((id) => !sourceIds.includes(id)),
    Date.now(),
  );
}
export function readPlanItem(
  db: Database.Database,
  planId: string,
  itemId: string,
) {
  const row = db
    .prepare(
      "SELECT id,kind,body_json AS bodyJson FROM items WHERE plan_id=? AND id=?",
    )
    .get(planId, itemId) as
    { id: string; kind: string; bodyJson: string } | undefined;
  if (!row) throw new Error("item-missing");
  const ids = db
    .prepare(
      "SELECT passage_id AS id FROM item_passages WHERE item_id=? ORDER BY passage_id",
    )
    .all(itemId) as { id: string }[];
  const body = JSON.parse(row.bodyJson) as { passageIds?: string[] };
  return { ...row, passageIds: body.passageIds ?? ids.map((row) => row.id) };
}
export function openPlanQuiz(
  db: Database.Database,
  planId: string,
  itemId: string,
) {
  const item = db
    .prepare("SELECT kind,topic_id FROM items WHERE plan_id=? AND id=?")
    .get(planId, itemId) as
    { kind: string; topic_id: string | null } | undefined;
  if (item?.kind !== "quiz" || !item.topic_id) throw new Error("quiz-missing");
  const attempt = db
    .prepare(
      "SELECT id FROM attempts WHERE plan_id=? AND item_id=? AND submitted_at IS NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(planId, itemId) as { id: string } | undefined;
  return {
    attemptId: attempt?.id ?? startAttempt(db, planId, itemId).attemptId,
  };
}

/** Imported trees may carry additional metadata; only supported text fields enter this view. */
export function topicTree(raw: string | null) {
  const value = raw ? (JSON.parse(raw) as unknown) : null;
  const tree =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { summary?: unknown; subtopics?: unknown })
      : {};
  return {
    summary: typeof tree.summary === "string" ? tree.summary : "",
    subtopics: Array.isArray(tree.subtopics)
      ? tree.subtopics.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
}
