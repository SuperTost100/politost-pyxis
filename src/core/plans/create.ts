import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { smartbookChapters } from "../sources/smartbook";

export type CreatedPlan = {
  planId: string;
  topics: number;
  pathNodes: number;
};

export function createPlan(
  db: Database.Database,
  input: { title: string; sourceIds: string[] },
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
     VALUES (?, ?, ?, 'lesson', ?, ?, ?)`,
  );
  let topics = 0;
  let pathNodes = 0;
  const topicIds: string[] = [];

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, ?, 'ready', ?, ?)`,
    ).run(planId, input.title, now, now);
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
    for (const [index, topicId] of topicIds.entries()) {
      const topic = db.prepare(`SELECT title FROM topics WHERE id = ?`).get(topicId) as {
        title: string;
      };
      insertNode.run(uuidv7(now + 1000 + index), planId, topicId, index, topic.title, now);
      pathNodes += 1;
    }
  });
  run();
  return { planId, topics, pathNodes };
}

export function readPlan(db: Database.Database, planId: string) {
  const plan = db
    .prepare(`SELECT id, title, status FROM plans WHERE id = ?`)
    .get(planId) as { id: string; title: string; status: string } | undefined;
  if (!plan) return null;
  const topics = db
    .prepare(`SELECT id, title, position FROM topics WHERE plan_id = ? ORDER BY position`)
    .all(planId) as Array<{ id: string; title: string; position: number }>;
  const nodes = db
    .prepare(
      `SELECT id, title, kind, position FROM path_nodes WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{ id: string; title: string; kind: string; position: number }>;
  return { ...plan, topics, nodes };
}

export function listPlans(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, title, status FROM plans ORDER BY updated_at DESC`,
    )
    .all() as Array<{ id: string; title: string; status: string }>;
}
