import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { planFileSchema, type PlanFile } from "../../shared/plan-file";

export type { PlanFile };

function clampTarget(value: number): number {
  if (!Number.isFinite(value)) return 0.75;
  return Math.min(1, Math.max(0.5, value));
}

export function exportPlan(db: Database.Database, planId: string): PlanFile {
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
      `SELECT title, kind, position, topic_id FROM path_nodes WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    title: string;
    kind: string;
    position: number;
    topic_id: string | null;
  }>;
  const cards = db
    .prepare(
      `SELECT front, back, topic_id FROM cards WHERE plan_id = ? AND removed = 0 ORDER BY created_at`,
    )
    .all(planId) as Array<{ front: string; back: string; topic_id: string | null }>;
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
  };
}

function topicRef(topicIds: string[], index: number | null): string | null {
  if (index == null) return null;
  const id = topicIds[index];
  if (!id) throw new Error("plan-file");
  return id;
}

export function importPlan(db: Database.Database, file: PlanFile, now = Date.now()): string {
  const parsed = planFileSchema.parse(file);
  const planId = uuidv7(now);
  const topicIds = parsed.topics.map((_, i) => uuidv7(now + i + 1));
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
      ).run(uuidv7(now + 100 + i), planId, topicId, node.kind, node.position, node.title, now);
    });
    parsed.cards.forEach((card, i) => {
      const topicId = topicRef(topicIds, card.topic);
      db.prepare(
        `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at)
         VALUES (?, ?, ?, ?, ?, 'sources', ?)`,
      ).run(uuidv7(now + 200 + i), planId, topicId, card.front, card.back, now);
    });
  });
  run();
  return planId;
}
