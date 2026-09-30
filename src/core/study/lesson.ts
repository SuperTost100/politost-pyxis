import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";

export type CacheKeyInput = {
  kind: string;
  scopeId: string;
  passageIds: string[];
  promptVersion: string;
};

export function cacheKey(input: CacheKeyInput): string {
  const passageIds = [...input.passageIds].sort();
  return JSON.stringify({
    kind: input.kind,
    scopeId: input.scopeId,
    promptVersion: input.promptVersion,
    passageIds,
  });
}

export type SaveLessonInput = {
  planId: string;
  topicId?: string | null;
  kind: string;
  key: string;
  markdown: string;
  passageIds: string[];
};

export type LoadedLesson = {
  markdown: string;
  passageIds: string[];
};

export function saveLesson(db: Database.Database, input: SaveLessonInput): string {
  const now = Date.now();
  const bodyJson = JSON.stringify({ cacheKey: input.key, markdown: input.markdown });

  const existing = db
    .prepare(
      `SELECT id FROM items
       WHERE plan_id = ? AND kind = ? AND json_extract(body_json, '$.cacheKey') = ?`,
    )
    .get(input.planId, input.kind, input.key) as { id: string } | undefined;

  let itemId: string;
  if (existing) {
    itemId = existing.id;
    db.prepare(`UPDATE items SET body_json = ?, topic_id = ? WHERE id = ?`).run(
      bodyJson,
      input.topicId ?? null,
      itemId,
    );
    db.prepare(`DELETE FROM item_passages WHERE item_id = ?`).run(itemId);
  } else {
    itemId = uuidv7(now);
    db.prepare(
      `INSERT INTO items
        (id, plan_id, topic_id, kind, body_json, grounding, created_at)
       VALUES (?, ?, ?, ?, ?, 'sources', ?)`,
    ).run(itemId, input.planId, input.topicId ?? null, input.kind, bodyJson, now);
  }

  const link = db.prepare(
    `INSERT INTO item_passages (item_id, passage_id) VALUES (?, ?)`,
  );
  for (const passageId of input.passageIds) {
    link.run(itemId, passageId);
  }
  return itemId;
}

export function loadLesson(
  db: Database.Database,
  input: { planId: string; kind: string; key: string },
): LoadedLesson | null {
  const row = db
    .prepare(
      `SELECT id, body_json FROM items
       WHERE plan_id = ? AND kind = ? AND json_extract(body_json, '$.cacheKey') = ?`,
    )
    .get(input.planId, input.kind, input.key) as { id: string; body_json: string } | undefined;

  if (!row) return null;

  const body = JSON.parse(row.body_json) as { cacheKey: string; markdown: string };
  const passages = db
    .prepare(`SELECT passage_id FROM item_passages WHERE item_id = ? ORDER BY passage_id`)
    .all(row.id) as Array<{ passage_id: string }>;

  return {
    markdown: body.markdown,
    passageIds: passages.map((p) => p.passage_id),
  };
}
