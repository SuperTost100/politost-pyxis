import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { uuidv7 } from "../../shared/ids";
import { planFileSchema, type PlanFile } from "../../shared/plan-file";
import { putBlob, readBlob } from "../blobs";

export type { PlanFile };

function clampTarget(value: number): number {
  if (!Number.isFinite(value)) return 0.75;
  return Math.min(1, Math.max(0.5, value));
}

export function exportPlan(
  db: Database.Database,
  planId: string,
  options?: { progress?: boolean; embed?: boolean; workspace?: string },
): PlanFile {
  const plan = db.prepare(
    `SELECT title, exam_at, target, content_language, style FROM plans WHERE id = ?`,
  ).get(planId) as
    | {
        title: string;
        exam_at: number | null;
        target: number;
        content_language: string | null;
        style: string;
      }
    | undefined;
  if (!plan) throw new Error("plan-missing");
  const topics = db
    .prepare(`SELECT id, title, position FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string; title: string; position: number }>;
  const index = new Map(topics.map((topic, i) => [topic.id, i]));
  const nodes = db
    .prepare(
      `SELECT id, title, kind, position, topic_id FROM path_nodes WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    kind: string;
    position: number;
    topic_id: string | null;
  }>;
  const nodeIndex = new Map(nodes.map((node, i) => [node.id, i]));
  const cards = db
    .prepare(
      `SELECT c.front, c.back, c.topic_id,
              (SELECT cr.rating FROM card_reviews cr
               WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS rating,
              (SELECT cr.state_json FROM card_reviews cr
               WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS state_json,
              (SELECT cr.reviewed_at FROM card_reviews cr
               WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS reviewed_at
       FROM cards c WHERE c.plan_id = ? AND c.removed = 0 ORDER BY c.created_at`,
    )
    .all(planId) as Array<{
    front: string;
    back: string;
    topic_id: string | null;
    rating: string | null;
    state_json: string | null;
    reviewed_at: number | null;
  }>;
  return {
    version: 1,
    title: plan.title,
    topics: topics.map((topic) => ({ title: topic.title, position: topic.position })),
    nodes: nodes.map((node) => ({
      title: node.title,
      kind: node.kind,
      position: node.position,
      topic: node.topic_id == null ? null : (index.get(node.topic_id) ?? null),
    })),
    cards: cards.map((card) => ({
      front: card.front,
      back: card.back,
      topic: card.topic_id == null ? null : (index.get(card.topic_id) ?? null),
      ...(options?.progress && card.state_json && card.rating != null && card.reviewed_at != null
        ? {
            schedule: {
              rating: card.rating,
              state: JSON.parse(card.state_json) as unknown,
              at: card.reviewed_at,
            },
          }
        : {}),
    })),
    examAt: plan.exam_at,
    target: clampTarget(plan.target),
    language:
      plan.content_language === "it" || plan.content_language === "en"
        ? plan.content_language
        : null,
    style:
      plan.style === "read" || plan.style === "practice" || plan.style === "decide"
        ? plan.style
        : "decide",
    sources: (
      db
        .prepare(
          `SELECT s.title, s.blob_sha, s.mime
           FROM plan_sources ps
           JOIN sources s ON s.id = ps.source_id
           WHERE ps.plan_id = ? AND s.status != 'removed'
           ORDER BY s.title`,
        )
        .all(planId) as Array<{ title: string; blob_sha: string | null; mime: string | null }>
    ).map((source) => {
      const file = sourceFile(options?.workspace ?? "", source.blob_sha, options?.embed === true);
      return {
        title: source.title,
        sha: source.blob_sha,
        bytes: file.bytes,
        mime: source.mime,
        ...(file.data !== undefined ? { data: file.data } : {}),
      };
    }),
    ...(options?.progress
      ? {
          progress: (
            db
              .prepare(
                `SELECT kind, topic_id, payload_json, created_at FROM learning_events
                 WHERE plan_id = ? ORDER BY created_at, rowid`,
              )
              .all(planId) as Array<{
              kind:
                | "answer_given"
                | "card_rated"
                | "lesson_opened"
                | "lesson_completed"
                | "simulation_submitted"
                | "active_time"
                | "gap_opened"
                | "gap_closed";
              topic_id: string | null;
              payload_json: string;
              created_at: number;
            }>
          ).map((event) => ({
            kind: event.kind,
            topic: event.topic_id == null ? null : (index.get(event.topic_id) ?? null),
            payload: exportedPayload(event.kind, JSON.parse(event.payload_json) as unknown, nodeIndex),
            at: event.created_at,
          })),
        }
      : {}),
  };
}

function exportedPayload(kind: string, payload: unknown, nodeIndex: Map<string, number>): unknown {
  if (kind !== "lesson_completed") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = { ...(payload as Record<string, unknown>) };
  if (typeof record.nodeId !== "string") {
    delete record.nodeId;
    return record;
  }
  const node = nodeIndex.get(record.nodeId);
  if (node == null) delete record.nodeId;
  else record.nodeId = node;
  return record;
}

function importedPayload(kind: string, payload: unknown, nodeIds: string[]): unknown {
  if (kind !== "lesson_completed") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = { ...(payload as Record<string, unknown>) };
  if (typeof record.nodeId !== "number") {
    delete record.nodeId;
    return record;
  }
  const id = nodeIds[record.nodeId];
  if (!id) throw new Error("plan-file");
  record.nodeId = id;
  return record;
}
function sourceFile(
  workspace: string,
  sha: string | null,
  embed: boolean,
): { bytes: number; data?: string } {
  if (!workspace || !sha) return { bytes: 0 };
  try {
    const record = readBlob(workspace, sha);
    const bytes = statSync(record.file).size;
    if (!embed) return { bytes };
    return { bytes, data: Buffer.from(readFileSync(record.file)).toString("base64") };
  } catch {
    return { bytes: 0 };
  }
}

function decodeSource(data: string, bytes: number): Buffer {
  if (data !== "" && (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))) {
    throw new Error("plan-file");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.length !== bytes) throw new Error("plan-file");
  return decoded;
}

function topicRef(topicIds: string[], index: number | null): string | null {
  if (index == null) return null;
  const id = topicIds[index];
  if (!id) throw new Error("plan-file");
  return id;
}

export function importPlan(
  db: Database.Database,
  file: PlanFile,
  now = Date.now(),
  workspace = "",
): string {
  const parsed = planFileSchema.parse(file);
  const planId = uuidv7(now);
  const topicIds = parsed.topics.map((_, i) => uuidv7(now + i + 1));
  const nodeIds = parsed.nodes.map((_, i) => uuidv7(now + 100 + i));
  const embedded = (parsed.sources ?? []).flatMap((source) => {
    if (source.data === undefined) return [];
    const bytes = decodeSource(source.data, source.bytes);
    if (!workspace) throw new Error("plan-file");
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (source.sha && source.sha !== sha) throw new Error("plan-file");
    return [{ title: source.title, mime: source.mime ?? null, bytes, sha }];
  });
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO plans (id, title, status, content_language, exam_at, target, style, created_at, updated_at)
       VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?)`,
    ).run(
      planId,
      parsed.title,
      parsed.language ?? null,
      parsed.examAt ?? null,
      parsed.target ?? 0.75,
      parsed.style ?? "decide",
      now,
      now,
    );
    parsed.topics.forEach((topic, i) => {
      db.prepare(
        `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(topicIds[i], planId, topic.title, topic.position, now);
    });
    parsed.nodes.forEach((node, i) => {
      const topicId = topicRef(topicIds, node.topic);
      db.prepare(
        `INSERT INTO path_nodes (id, plan_id, topic_id, kind, position, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(nodeIds[i], planId, topicId, node.kind, node.position, node.title, now);
    });
    parsed.cards.forEach((card, i) => {
      const topicId = topicRef(topicIds, card.topic);
      const cardId = uuidv7(now + 200 + i);
      db.prepare(
        `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at)
         VALUES (?, ?, ?, ?, ?, 'sources', ?)`,
      ).run(cardId, planId, topicId, card.front, card.back, now);
      if (card.schedule) {
        db.prepare(
          `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          uuidv7(now + 400 + i),
          cardId,
          card.schedule.rating,
          JSON.stringify(
            card.schedule.state && typeof card.schedule.state === "object"
              ? card.schedule.state
              : {},
          ),
          card.schedule.at,
        );
      }
    });
    (parsed.progress ?? []).forEach((event, i) => {
      const topicId = topicRef(topicIds, event.topic);
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        uuidv7(now + 300 + i),
        event.kind,
        planId,
        topicId,
        JSON.stringify(importedPayload(event.kind, event.payload, nodeIds) ?? {}),
        event.at,
      );
    });
    embedded.forEach((source, i) => {
      putBlob(workspace, source.bytes, source.mime ?? "application/octet-stream", "bin");
      const sourceId = uuidv7(now + 500 + i);
      db.prepare(
        `INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
         VALUES (?, 'file', ?, ?, ?, 'ready', ?, ?)`,
      ).run(sourceId, source.title, source.sha, source.mime, now, now);
      db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)`).run(planId, sourceId);
    });
  });
  run();
  return planId;
}
