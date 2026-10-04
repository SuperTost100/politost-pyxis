import { planOrigin, topicContent, topicTree } from "./views";
import { addSubject } from "./subjects";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { reachableTarget } from "../../shared/plan-file";
import { bestRecommendation, pathState, type Stage } from "./path";
import { dueCards } from "../study/cards";
import { planMastery, weightedPlanMastery } from "./progress";
import { smartbookChapters } from "../sources/smartbook";

export type BuildTopic = {
  title: string;
  summary: string;
  subtopics: string[];
  passageIds: string[];
  provider?: string;
  model?: string;
};

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
    topicTitles?: string[];
    signal?: AbortSignal;
    buildId?: string;
    tree?: BuildTopic[];
  },
  now = Date.now(),
): CreatedPlan {
  const planId = input.buildId ?? uuidv7(now);
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
    if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const subjectName = input.subject?.trim() ?? "";
    let subjectId: string | null = null;
    if (subjectName) {
      subjectId = addSubject(db, subjectName).id;
    }
    db.prepare(
      `INSERT INTO plans (id, title, status, subject_id, content_language, exam_at, target, style, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    ).run(
      planId,
      input.title,
      input.sourceIds.length === 0 ? "draft" : "ready",
      subjectId,
      input.language ?? null,
      input.examAt ?? null,
      input.target ?? 0.75,
      input.style ?? "decide",
      now,
      now,
    );
    if (input.tree) {
      for (const sourceId of input.sourceIds)
        db.prepare(
          "INSERT OR IGNORE INTO plan_sources (plan_id, source_id) VALUES (?, ?)",
        ).run(planId, sourceId);
      for (const topic of input.tree) {
        const topicId = uuidv7(now + topics + 1);
        insertTopic.run(topicId, planId, topic.title, topics, now);
        db.prepare(
          "UPDATE topics SET tree_json = ?, engine_provider = ?, model_id = ?, model_source = ?, grounding = ? WHERE id = ?",
        ).run(
          JSON.stringify({
            summary: topic.summary,
            subtopics: topic.subtopics,
          }),
          topic.provider ?? null,
          topic.model ?? null,
          topic.model ? "reported" : null,
          topic.passageIds.length ? "sources" : "general",
          topicId,
        );
        const link = db.prepare(
          "INSERT OR IGNORE INTO topic_passages (topic_id, passage_id) VALUES (?, ?)",
        );
        for (const passageId of topic.passageIds) link.run(topicId, passageId);
        topicIds.push(topicId);
        topics += 1;
      }
    } else
      for (const [sourceIndex, sourceId] of input.sourceIds.entries()) {
        const before = topicIds.length;
        db.prepare(
          `INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)`,
        ).run(planId, sourceId);
        const chapters = smartbookChapters(db, sourceId);
        if (input.signal?.aborted)
          throw new DOMException("aborted", "AbortError");
        if (chapters.length === 0) {
          const sections = db
            .prepare(
              `SELECT DISTINCT section_path AS section FROM passages
             WHERE source_id = ? AND section_path IS NOT NULL AND TRIM(section_path) != ''
             ORDER BY section_path`,
            )
            .all(sourceId) as Array<{ section: string }>;
          if (sections.length > 0) {
            const linkSection = db.prepare(
              `INSERT INTO topic_passages (topic_id, passage_id)
             SELECT ?, id FROM passages WHERE source_id = ? AND section_path = ?`,
            );
            for (const section of sections) {
              const topicId = uuidv7(now + topics + 1);
              insertTopic.run(topicId, planId, section.section, topics, now);
              linkSection.run(topicId, sourceId, section.section);
              topicIds.push(topicId);
              topics += 1;
            }
          } else {
            const source = db
              .prepare(`SELECT title FROM sources WHERE id = ?`)
              .get(sourceId) as { title: string } | undefined;
            const topicId = uuidv7(now + topics + 1);
            insertTopic.run(
              topicId,
              planId,
              source?.title ?? input.title,
              topics,
              now,
            );
            linkAll.run(topicId, sourceId);
            topicIds.push(topicId);
            topics += 1;
          }
        } else {
          for (const chapter of chapters) {
            const topicId = uuidv7(now + topics + 1);
            insertTopic.run(
              topicId,
              planId,
              `${chapter.number}. ${chapter.title}`,
              topics,
              now,
            );
            linkPassage.run(topicId, sourceId, chapter.number);
            topicIds.push(topicId);
            topics += 1;
          }
        }
        const override = input.topicTitles?.[sourceIndex]?.trim();
        if (override && topicIds.length === before + 1) {
          const topicId = topicIds[before];
          if (topicId)
            db.prepare(`UPDATE topics SET title = ? WHERE id = ?`).run(
              override,
              topicId,
            );
        }
      }
    const titles = new Map(
      (
        db
          .prepare(`SELECT id, title FROM topics WHERE plan_id = ?`)
          .all(planId) as Array<{
          id: string;
          title: string;
        }>
      ).map((row) => [row.id, row.title]),
    );
    const sequence: Array<{
      stage: Stage;
      topicId: string | null;
      title: string;
    }> = [
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

export function rebuildPlan(
  db: Database.Database,
  planId: string,
  sourceIds: string[],
  now = Date.now(),
): { topics: number } {
  const plan = db
    .prepare(`SELECT id, title, style FROM plans WHERE id = ?`)
    .get(planId) as { id: string; title: string; style: string } | undefined;
  if (!plan) throw new Error("plan-missing");
  const linked = new Set(
    (
      db
        .prepare(`SELECT source_id FROM plan_sources WHERE plan_id = ?`)
        .all(planId) as Array<{
        source_id: string;
      }>
    ).map((row) => row.source_id),
  );
  const byTitle = new Map(
    (
      db
        .prepare(`SELECT id, title FROM topics WHERE plan_id = ?`)
        .all(planId) as Array<{
        id: string;
        title: string;
      }>
    ).map((row) => [row.title, row.id]),
  );
  let added = 0;
  const created: string[] = [];
  const position = () =>
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM topics WHERE plan_id = ?`)
        .get(planId) as { n: number }
    ).n;
  const run = db.transaction(() => {
    for (const sourceId of sourceIds) {
      if (
        linked.has(sourceId) &&
        db
          .prepare(
            "SELECT 1 FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id JOIN passages p ON p.id=tp.passage_id WHERE t.plan_id=? AND p.source_id=? LIMIT 1",
          )
          .get(planId, sourceId)
      )
        continue;
      db.prepare(
        `INSERT OR IGNORE INTO plan_sources (plan_id, source_id) VALUES (?, ?)`,
      ).run(planId, sourceId);
      const chapters = smartbookChapters(db, sourceId);
      const groups: Array<{
        title: string;
        kind: "chapter" | "section" | "all";
        key: string;
      }> =
        chapters.length > 0
          ? chapters.map((chapter) => ({
              title: `${chapter.number}. ${chapter.title}`,
              kind: "chapter",
              key: String(chapter.number),
            }))
          : (
              db
                .prepare(
                  `SELECT DISTINCT section_path AS section FROM passages
                   WHERE source_id = ? AND section_path IS NOT NULL AND TRIM(section_path) != ''`,
                )
                .all(sourceId) as Array<{ section: string }>
            ).map((row) => ({
              title: row.section,
              kind: "section" as const,
              key: row.section,
            }));
      const rows =
        groups.length > 0
          ? groups
          : [{ title: "", kind: "all" as const, key: "" }];
      for (const group of rows) {
        const source = db
          .prepare(`SELECT title FROM sources WHERE id = ?`)
          .get(sourceId) as { title: string } | undefined;
        const title =
          group.kind === "all" ? (source?.title ?? "Note") : group.title;
        const existing = byTitle.get(title);
        const topicId = existing ?? uuidv7(now + added + 1);
        if (!existing) {
          db.prepare(
            `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, ?, ?, ?, ?)`,
          ).run(topicId, planId, title, position(), now);
          byTitle.set(title, topicId);
          added += 1;
          created.push(topicId);
        }
        db.prepare(
          `INSERT OR IGNORE INTO topic_passages (topic_id, passage_id)
           SELECT ?, id FROM passages WHERE source_id = ?
             AND (
               (? = 'all')
               OR (? = 'section' AND section_path = ?)
               OR (? = 'chapter' AND json_extract(locator_json, '$.chapter') = ?)
             )`,
        ).run(
          topicId,
          sourceId,
          group.kind,
          group.kind,
          group.key,
          group.kind,
          Number(group.key),
        );
      }
    }
    const stages =
      plan.style === "practice"
        ? (["practice", "learn", "cards", "gaps"] as const)
        : (["learn", "practice", "cards", "gaps"] as const);
    const tail = db
      .prepare(
        `SELECT id, position FROM path_nodes
         WHERE plan_id = ? AND kind IN ('simulation', 'final')
         ORDER BY position`,
      )
      .all(planId) as Array<{ id: string; position: number }>;
    const insertAt =
      tail[0]?.position ??
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM path_nodes WHERE plan_id = ?`)
          .get(planId) as {
          n: number;
        }
      ).n;
    if (created.length > 0 && tail.length > 0) {
      db.prepare(
        `UPDATE path_nodes SET position = position + ? WHERE plan_id = ? AND position >= ?`,
      ).run(created.length * stages.length, planId, insertAt);
    }
    const insertNode = db.prepare(
      `INSERT INTO path_nodes (id, plan_id, topic_id, kind, position, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    created.forEach((topicId, topicIndex) => {
      const title = (
        db.prepare(`SELECT title FROM topics WHERE id = ?`).get(topicId) as {
          title: string;
        }
      ).title;
      stages.forEach((stage, stageIndex) => {
        insertNode.run(
          uuidv7(now + 1000 + topicIndex * stages.length + stageIndex),
          planId,
          topicId,
          stage,
          insertAt + topicIndex * stages.length + stageIndex,
          title,
          now,
        );
      });
    });
    if (sourceIds.length > 0) {
      db.prepare(
        `UPDATE plans SET status = 'ready', updated_at = ? WHERE id = ?`,
      ).run(now, planId);
    }
  });
  run();
  return { topics: added };
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
    .prepare(
      `SELECT id, topic_id, kind FROM path_nodes WHERE id = ? AND plan_id = ?`,
    )
    .get(nodeId, planId) as
    { id: string; topic_id: string | null; kind: string } | undefined;
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
    .prepare(
      `SELECT p.id, p.title, p.status, p.target, p.exam_at AS examAt, p.content_language AS contentLanguage, s.name AS subject FROM plans p LEFT JOIN subjects s ON s.id=p.subject_id WHERE p.id = ?`,
    )
    .get(planId) as
    | {
        id: string;
        title: string;
        status: string;
        target: number;
        examAt: number | null;
        contentLanguage: string | null;
        subject: string | null;
      }
    | undefined;
  if (!plan) return null;
  const topics = db
    .prepare(
      `SELECT id, title, position, tree_json FROM topics WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    position: number;
    tree_json: string | null;
  }>;
  const topicViews = topics.map(({ tree_json, ...topic }) => ({
    ...topic,
    ...topicContent(db, planId, topic.id),
    ...topicTree(tree_json),
  }));
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
    mastery[topic.id] = simulationDone
      ? topic.mastery
      : Math.min(topic.mastery, 0.5);
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
    unlockReason: states.find((item) => item.id === row.id)?.reason ?? "",
    state:
      plan.status === "building"
        ? "locked"
        : (states.find((item) => item.id === row.id)?.state ?? "locked"),
  }));
  return {
    ...plan,
    ...planOrigin(db, planId),
    topics: topicViews,
    nodes,
    sources: db
      .prepare(
        `SELECT s.id, s.title, s.kind, s.status FROM sources s
       JOIN plan_sources ps ON ps.source_id = s.id
       WHERE ps.plan_id = ?
       ORDER BY s.title`,
      )
      .all(planId) as Array<{
      id: string;
      title: string;
      kind: string;
      status: string;
    }>,
  };
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
      `SELECT p.id, p.title, p.status, p.exam_at, p.target, s.name AS subject,
       EXISTS(SELECT 1 FROM settings x WHERE x.key = 'plan-import:' || p.id) AS imported
       FROM plans p
       LEFT JOIN subjects s ON s.id = p.subject_id
       ORDER BY CASE WHEN p.exam_at < ? THEN 2 WHEN p.exam_at IS NULL THEN 1 ELSE 0 END,
                p.exam_at ASC, p.updated_at DESC`,
    )
    .all(new Date(now).setHours(0, 0, 0, 0)) as Array<{
    id: string;
    title: string;
    status: string;
    exam_at: number | null;
    target: number;
    imported: number;
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
    const counts = new Map(
      (
        db
          .prepare(
            "SELECT t.id, count(tp.passage_id) AS n FROM topics t LEFT JOIN topic_passages tp ON tp.topic_id=t.id WHERE t.plan_id=? GROUP BY t.id",
          )
          .all(row.id) as { id: string; n: number }[]
      ).map((t) => [t.id, t.n]),
    );
    const mastery = weightedPlanMastery(
      topics.map((topic) => ({
        ...topic,
        mastery: simulationDone ? topic.mastery : Math.min(topic.mastery, 0.5),
      })),
      counts,
    );
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      subject: row.subject,
      daysToExam: row.exam_at == null ? null : daysUntil(row.exam_at, now),
      mastery,
      target: row.target,
      imported: Boolean(row.imported),
      alignedTopics: topics.filter((topic) => topic.mastery >= row.target)
        .length,
      totalTopics: topics.length,
    };
  });
}

export function nextLesson(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  const plan = readPlan(db, planId);
  if (!plan) return null;
  const meta = db
    .prepare(`SELECT exam_at, target, style FROM plans WHERE id = ?`)
    .get(planId) as
    { exam_at: number | null; target: number; style: string } | undefined;
  if (!meta) return null;
  const daysToExam =
    meta.exam_at == null ? 30 : Math.max(1, daysUntil(meta.exam_at, now));
  const candidates = plan.nodes.flatMap((node) => {
    if (node.state !== "current") return [];
    const due = node.topicId
      ? dueCards(db, planId, now, node.topicId).length
      : 0;
    const gaps = node.topicId
      ? (db
          .prepare(
            `SELECT COUNT(*) AS n FROM gaps
             WHERE plan_id = ? AND topic_id = ? AND closed_at IS NULL`,
          )
          .get(planId, node.topicId) as { n: number })
      : { n: 0 };
    const mastery = node.topicId
      ? (planMastery(db, planId, now).find((topic) => topic.id === node.topicId)
          ?.mastery ?? 0)
      : 0;
    const last = node.topicId
      ? (db
          .prepare(
            `SELECT MAX(created_at) AS at FROM learning_events WHERE plan_id = ? AND topic_id = ?`,
          )
          .get(planId, node.topicId) as { at: number | null })
      : { at: null };
    const daysIdle =
      last.at == null ? 0 : Math.max(0, -daysUntil(last.at, now));
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
  if (chosen.dueCards > 0)
    return {
      nodeId: chosen.id,
      reason: "due" as const,
      count: chosen.dueCards,
    };
  if (chosen.severeGaps > 0) {
    return {
      nodeId: chosen.id,
      reason: "gaps" as const,
      count: chosen.severeGaps,
    };
  }
  return { nodeId: chosen.id, reason: "next" as const, count: 0 };
}

export function listSubjects(db: Database.Database) {
  return db
    .prepare(`SELECT id, name FROM subjects ORDER BY position, name, id`)
    .all() as Array<{
    id: string;
    name: string;
  }>;
}
