import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { pathState, type Stage } from "./path";
import { planMastery } from "./progress";
import { smartbookChapters } from "../sources/smartbook";

export type CreatedPlan = {
  planId: string;
  topics: number;
  pathNodes: number;
};

export function createPlan(
  db: Database.Database,
  input: {
    title: string;
    sourceIds: string[];
    examAt?: number | null;
    target?: number;
    language?: string;
    style?: "read" | "practice" | "decide";
  },
  now = Date.now(),
): CreatedPlan {
  const planId = uuidv7(now);
  const insertTopic = db.prepare(
    `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const linkPassage = db.prepare(
    `INSERT INTO topic_passages (topic_id, passage_id)
     SELECT ?, id FROM passages
     WHERE source_id = ? AND json_extract(locator_json, '$.chapter') = ?`,
  );
  const linkAll = db.prepare(
    `INSERT INTO topic_passages (topic_id, passage_id)
     SELECT ?, id FROM passages WHERE source_id = ?`,
  );
  const insertNode = db.prepare(
    `INSERT INTO path_nodes (id, plan_id, topic_id, kind, position, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let topics = 0;
  let pathNodes = 0;
  const topicIds: string[] = [];

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO plans (id, title, status, content_language, exam_at, target, style, created_at, updated_at)
       VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?)`,
    ).run(
      planId,
      input.title,
      input.language ?? null,
      input.examAt ?? null,
      input.target ?? 0.75,
      input.style ?? "decide",
      now,
      now,
    );
    for (const sourceId of input.sourceIds) {
      db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)`).run(
        planId,
        sourceId,
      );
      const chapters = smartbookChapters(db, sourceId);
      if (chapters.length === 0) {
        const source = db.prepare(`SELECT title FROM sources WHERE id = ?`).get(sourceId) as
          | { title: string }
          | undefined;
        const topicId = uuidv7(now + topics + 1);
        insertTopic.run(topicId, planId, source?.title ?? input.title, topics, now);
        linkAll.run(topicId, sourceId);
        topicIds.push(topicId);
        topics += 1;
        continue;
      }
      for (const chapter of chapters) {
        const topicId = uuidv7(now + topics + 1);
        insertTopic.run(topicId, planId, `${chapter.number}. ${chapter.title}`, topics, now);
        linkPassage.run(topicId, sourceId, chapter.number);
        topicIds.push(topicId);
        topics += 1;
      }
    }
    const titles = new Map(
      (
        db.prepare(`SELECT id, title FROM topics WHERE plan_id = ?`).all(planId) as Array<{
          id: string;
          title: string;
        }>
      ).map((row) => [row.id, row.title]),
    );
    const sequence: Array<{ stage: Stage; topicId: string | null; title: string }> = [
      { stage: "intro", topicId: null, title: input.title },
      { stage: "diagnostic", topicId: null, title: input.title },
    ];
    for (const topicId of topicIds) {
      const title = titles.get(topicId) ?? input.title;
      const middle =
        input.style === "practice"
          ? (["practice", "learn", "cards", "gaps"] as const)
          : (["learn", "practice", "cards", "gaps"] as const);
      for (const stage of middle) {
        sequence.push({ stage, topicId, title });
      }
    }
    sequence.push(
      { stage: "simulation", topicId: null, title: input.title },
      { stage: "final", topicId: null, title: input.title },
    );
    sequence.forEach((node, index) => {
      insertNode.run(
        uuidv7(now + 1000 + index),
        planId,
        node.topicId,
        node.stage,
        index,
        node.title,
        now,
      );
      pathNodes += 1;
    });
  });
  run();
  return { planId, topics, pathNodes };
}

export function deletePlan(db: Database.Database, planId: string): void {
  const info = db.prepare(`DELETE FROM plans WHERE id = ?`).run(planId);
  if (info.changes === 0) throw new Error("plan-missing");
}

export function completeNode(
  db: Database.Database,
  planId: string,
  nodeId: string,
  now = Date.now(),
): void {
  const node = db
    .prepare(`SELECT id, topic_id FROM path_nodes WHERE id = ? AND plan_id = ?`)
    .get(nodeId, planId) as { id: string; topic_id: string | null } | undefined;
  if (!node) throw new Error("node-missing");
  const open = readPlan(db, planId)?.nodes.find((item) => item.id === nodeId);
  if (open?.state !== "current") throw new Error("node-locked");
  db.prepare(
    `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
     VALUES (?, 'lesson_completed', ?, ?, ?, ?)`,
  ).run(uuidv7(now), planId, node.topic_id, JSON.stringify({ nodeId }), now);
}

export function readPlan(db: Database.Database, planId: string) {
  const plan = db
    .prepare(`SELECT id, title, status FROM plans WHERE id = ?`)
    .get(planId) as { id: string; title: string; status: string } | undefined;
  if (!plan) return null;
  const topics = db
    .prepare(`SELECT id, title, position FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string; title: string; position: number }>;
  const rows = db
    .prepare(
      `SELECT id, title, kind, topic_id, position FROM path_nodes WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    kind: string;
    topic_id: string | null;
    position: number;
  }>;
  const events = db
    .prepare(
      `SELECT payload_json, topic_id FROM learning_events
       WHERE plan_id = ? AND kind = 'lesson_completed'`,
    )
    .all(planId) as Array<{ payload_json: string; topic_id: string | null }>;
  const doneIds = events.flatMap((event) => {
    const payload = JSON.parse(event.payload_json) as { nodeId?: string };
    return payload.nodeId ? [payload.nodeId] : [];
  });
  const simulationDone = rows.some(
    (row) => row.kind === "simulation" && doneIds.includes(row.id),
  );
  const mastery: Record<string, number> = {};
  for (const topic of planMastery(db, planId)) {
    mastery[topic.id] = simulationDone ? Math.max(topic.mastery, 0.8) : Math.min(topic.mastery, 0.5);
  }
  const states = pathState(
    rows.map((row) => ({
      id: row.id,
      stage: row.kind as Stage,
      topicId: row.topic_id,
      position: row.position,
    })),
    doneIds,
    mastery,
  );
  const nodes = rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    topicId: row.topic_id,
    position: row.position,
    state: states.find((item) => item.id === row.id)?.state ?? "locked",
  }));
  return { ...plan, topics, nodes };
}

export function listPlans(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, title, status FROM plans ORDER BY updated_at DESC`,
    )
    .all() as Array<{ id: string; title: string; status: string }>;
}
