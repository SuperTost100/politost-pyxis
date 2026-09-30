import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { reachableTarget } from "../../shared/plan-file";
import { bestRecommendation, pathState, type Stage } from "./path";
import { dueCards } from "../study/cards";
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
    subject?: string;
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
    const subjectName = input.subject?.trim() ?? "";
    let subjectId: string | null = null;
    if (subjectName) {
      const existing = db.prepare(`SELECT id FROM subjects WHERE name = ?`).get(subjectName) as
        | { id: string }
        | undefined;
      subjectId = existing?.id ?? uuidv7(now);
      if (!existing) {
        db.prepare(`INSERT INTO subjects (id, name, created_at) VALUES (?, ?, ?)`).run(
          subjectId,
          subjectName,
          now,
        );
      }
    }
    db.prepare(
      `INSERT INTO plans (id, title, status, subject_id, content_language, exam_at, target, style, created_at, updated_at)
       VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      planId,
      input.title,
      subjectId,
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
    .prepare(`SELECT id, topic_id, kind FROM path_nodes WHERE id = ? AND plan_id = ?`)
    .get(nodeId, planId) as { id: string; topic_id: string | null; kind: string } | undefined;
  if (!node) throw new Error("node-missing");
  const open = readPlan(db, planId)?.nodes.find((item) => item.id === nodeId);
  if (open?.state !== "current") throw new Error("node-locked");
  db.prepare(
    `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
     VALUES (?, 'lesson_completed', ?, ?, ?, ?)`,
  ).run(
    uuidv7(now),
    planId,
    node.kind === "learn" ? node.topic_id : null,
    JSON.stringify({ nodeId }),
    now,
  );
}

export function completeCurrentStage(
  db: Database.Database,
  planId: string,
  kind: string,
  now = Date.now(),
): void {
  const node = db
    .prepare(`SELECT id FROM path_nodes WHERE plan_id = ? AND kind = ?`)
    .get(planId, kind) as { id: string } | undefined;
  if (!node) return;
  try {
    completeNode(db, planId, node.id, now);
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "node-locked") throw err;
  }
}

export function readPlan(db: Database.Database, planId: string) {
  const plan = db
    .prepare(`SELECT id, title, status, target FROM plans WHERE id = ?`)
    .get(planId) as { id: string; title: string; status: string; target: number } | undefined;
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
    mastery[topic.id] = simulationDone ? topic.mastery : Math.min(topic.mastery, 0.5);
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
    reachableTarget(plan.target),
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

function daysUntil(examAt: number, now: number): number {
  const exam = new Date(examAt);
  exam.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((exam.getTime() - today.getTime()) / 86_400_000);
}

export function listPlans(db: Database.Database, now = Date.now()) {
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.status, p.exam_at, s.name AS subject
       FROM plans p
       LEFT JOIN subjects s ON s.id = p.subject_id
       ORDER BY p.updated_at DESC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    status: string;
    exam_at: number | null;
    subject: string | null;
  }>;
  return rows.map((row) => {
    const topics = planMastery(db, row.id, now);
    const simulationDone = db
      .prepare(
        `SELECT 1 AS ok FROM path_nodes n
         WHERE n.plan_id = ? AND n.kind = 'simulation'
           AND EXISTS (
             SELECT 1 FROM learning_events e
             WHERE e.plan_id = n.plan_id AND e.kind = 'lesson_completed'
               AND json_extract(e.payload_json, '$.nodeId') = n.id
           )`,
      )
      .get(row.id);
    const levels = topics.map((topic) =>
      simulationDone ? topic.mastery : Math.min(topic.mastery, 0.5),
    );
    const mastery = levels.length === 0 ? 0 : levels.reduce((sum, level) => sum + level, 0) / levels.length;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      subject: row.subject,
      daysToExam: row.exam_at == null ? null : daysUntil(row.exam_at, now),
      mastery,
    };
  });
}

export function nextLesson(db: Database.Database, planId: string, now = Date.now()) {
  const plan = readPlan(db, planId);
  if (!plan) return null;
  const meta = db
    .prepare(`SELECT exam_at, target, style FROM plans WHERE id = ?`)
    .get(planId) as { exam_at: number | null; target: number; style: string } | undefined;
  if (!meta) return null;
  const daysToExam = meta.exam_at == null ? 30 : Math.max(1, daysUntil(meta.exam_at, now));
  const candidates = plan.nodes.flatMap((node) => {
    if (node.state !== "current") return [];
    const due = node.topicId ? dueCards(db, planId, now, node.topicId).length : 0;
    const gaps = node.topicId
      ? (db
          .prepare(
            `SELECT COUNT(*) AS n FROM gaps
             WHERE plan_id = ? AND topic_id = ? AND closed_at IS NULL`,
          )
          .get(planId, node.topicId) as { n: number })
      : { n: 0 };
    const mastery = node.topicId
      ? (planMastery(db, planId, now).find((topic) => topic.id === node.topicId)?.mastery ?? 0)
      : 0;
    const last = node.topicId
      ? (db
          .prepare(
            `SELECT MAX(created_at) AS at FROM learning_events WHERE plan_id = ? AND topic_id = ?`,
          )
          .get(planId, node.topicId) as { at: number | null })
      : { at: null };
    const daysIdle = last.at == null ? 0 : Math.max(0, -daysUntil(last.at, now));
    const styleMatch =
      (meta.style === "practice" && node.kind === "practice") ||
      (meta.style === "read" && node.kind === "learn")
        ? 1
        : 0;
    return [
      {
        id: node.id,
        dueCards: due,
        severeGaps: gaps.n,
        topicMastery: mastery,
        target: meta.target,
        daysToExam,
        daysIdle,
        styleMatch,
      },
    ];
  });
  const best = bestRecommendation(candidates);
  if (!best) return null;
  const chosen = candidates.find((item) => item.id === best.id);
  if (!chosen) return null;
  if (chosen.dueCards > 0) return { nodeId: chosen.id, reason: "due" as const, count: chosen.dueCards };
  if (chosen.severeGaps > 0) {
    return { nodeId: chosen.id, reason: "gaps" as const, count: chosen.severeGaps };
  }
  return { nodeId: chosen.id, reason: "next" as const, count: 0 };
}

export function listSubjects(db: Database.Database) {
  return db.prepare(`SELECT id, name FROM subjects ORDER BY name`).all() as Array<{
    id: string;
    name: string;
  }>;
}
