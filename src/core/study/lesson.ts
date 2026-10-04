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
  /** Set only for model-written lessons. */
  engine?: { provider: string; model: string };
  /** Prompt provenance for model-written lessons. */
  prompt?: { template: string; version: string };
  /** Defaults to "sources"; "general" marks model knowledge with no passages (LES-32). */
  grounding?: "sources" | "general";
};

export type LoadedLesson = {
  itemId: string;
  grounding: string | null;
  markdown: string;
  passageIds: string[];
  /** Present only when a model wrote the lesson. */
  provider?: string;
};

export function saveLesson(
  db: Database.Database,
  input: SaveLessonInput,
): string {
  const now = Date.now();
  const bodyJson = JSON.stringify({
    cacheKey: input.key,
    markdown: input.markdown,
    passageIds: input.passageIds,
  });
  const provider = input.engine?.provider ?? null;
  const model = input.engine?.model ?? null;
  const source = input.engine ? "reported" : null;
  const template = input.prompt?.template ?? null;
  const version = input.prompt?.version ?? null;
  const grounding = input.grounding ?? "sources";

  return db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT id FROM items
         WHERE plan_id = ? AND kind = ? AND json_extract(body_json, '$.cacheKey') = ?`,
      )
      .get(input.planId, input.kind, input.key) as { id: string } | undefined;

    let itemId: string;
    if (existing) {
      itemId = existing.id;
      db.prepare(
        `UPDATE items SET body_json = ?, topic_id = ?, engine_provider = ?, model_id = ?, model_source = ?, prompt_template = ?, prompt_version = ?, grounding = ? WHERE id = ?`,
      ).run(
        bodyJson,
        input.topicId ?? null,
        provider,
        model,
        source,
        template,
        version,
        grounding,
        itemId,
      );
      db.prepare(`DELETE FROM item_passages WHERE item_id = ?`).run(itemId);
    } else {
      itemId = uuidv7(now);
      db.prepare(
        `INSERT INTO items
          (id, plan_id, topic_id, kind, body_json, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        itemId,
        input.planId,
        input.topicId ?? null,
        input.kind,
        bodyJson,
        provider,
        model,
        source,
        template,
        version,
        grounding,
        now,
      );
    }

    const link = db.prepare(
      `INSERT INTO item_passages (item_id, passage_id) VALUES (?, ?)`,
    );
    for (const passageId of input.passageIds) {
      link.run(itemId, passageId);
    }
    return itemId;
  })();
}

export function loadLesson(
  db: Database.Database,
  input: { planId: string; kind: string; key: string },
): LoadedLesson | null {
  const row = db
    .prepare(
      `SELECT id, body_json, engine_provider, grounding FROM items
       WHERE plan_id = ? AND kind = ? AND json_extract(body_json, '$.cacheKey') = ?`,
    )
    .get(input.planId, input.kind, input.key) as
    | {
        id: string;
        body_json: string;
        engine_provider: string | null;
        grounding: string | null;
      }
    | undefined;

  if (!row) return null;

  const body = JSON.parse(row.body_json) as {
    cacheKey: string;
    markdown: string;
    passageIds?: string[];
  };
  const passages = db
    .prepare(
      `SELECT ip.passage_id FROM item_passages ip JOIN passages p ON p.id = ip.passage_id WHERE ip.item_id = ? ORDER BY p.created_at, p.id`,
    )
    .all(row.id) as Array<{ passage_id: string }>;

  return {
    itemId: row.id,
    grounding: row.grounding,
    markdown: body.markdown,
    passageIds: body.passageIds ?? passages.map((p) => p.passage_id),
    ...(row.engine_provider ? { provider: row.engine_provider } : {}),
  };
}
