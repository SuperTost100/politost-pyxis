import { planOrigin, topicContent, topicTree } from "./views";
import { addSubject } from "./subjects";
import { planEducation } from "./education";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { reachableTarget } from "../../shared/plan-file";
import { suggestStep, topicSuggestion, type Stage, type TopicStatus } from "./path";
import { readSteps } from "./steps";
import { dueCards } from "../study/cards";
import { gapSeverity, planMastery, syncGaps, weightedPlanMastery } from "./progress";
import { smartbookChapters } from "../sources/smartbook";

export type BuildTopic = {
  title: string;
  summary: string;
  subtopics: string[];
  passageIds: string[];
  provider?: string;
  model?: string;
};

export type DraftTopic = {
  title: string;
  summary?: string;
  subtopics?: string[];
};

/** The edited tree from the guided flow, used only when the plan has no material. */
export function draftTree(input: {
  sourceIds: string[];
  draftTopics?: DraftTopic[];
}): BuildTopic[] | undefined {
  if (input.sourceIds.length || !input.draftTopics?.length) return undefined;
  return input.draftTopics.map((topic) => ({
    title: topic.title,
    summary: topic.summary ?? "",
    subtopics: topic.subtopics ?? [],
    passageIds: [],
  }));
}

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
    draftTopics?: DraftTopic[];
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
    // ASK-09: the plan keeps the level the profile had when it was made; a build job already stored it.
    planEducation(db, planId, now);
    const tree = input.tree ?? draftTree(input);
    if (tree) {
      for (const sourceId of input.sourceIds)
        db.prepare(
          "INSERT OR IGNORE INTO plan_sources (plan_id, source_id) VALUES (?, ?)",
        ).run(planId, sourceId);
      for (const topic of tree) {
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

export function deletePlan(db: Database.Database, planId: string): void {
  const info = db.prepare(`DELETE FROM plans WHERE id = ?`).run(planId);
  if (info.changes === 0) throw new Error("plan-missing");
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
      `SELECT id, title, position, tree_json, grounding FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    position: number;
    tree_json: string | null;
    grounding: "sources" | "mixed" | "general" | null;
  }>;
  const topicViews = topics.map(({ tree_json, ...topic }) => ({
    ...topic,
    ...topicContent(db, planId, topic.id),
    ...topicTree(tree_json),
  }));
  return {
    ...plan,
    ...planOrigin(db, planId),
    topics: topicViews,
    steps: readSteps(db, planId),
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
    const counts = new Map(
      (
        db
          .prepare(
            "SELECT t.id, count(tp.passage_id) AS n FROM topics t LEFT JOIN topic_passages tp ON tp.topic_id=t.id WHERE t.plan_id=? GROUP BY t.id",
          )
          .all(row.id) as { id: string; n: number }[]
      ).map((t) => [t.id, t.n]),
    );
    const mastery = weightedPlanMastery(topics, counts);
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

/**
 * What the path suggests next, and for each topic what fits it now. Every activity stays open; this only picks
 * the first offer. Gap rows follow the answers only when synced; Progress syncs before it reads them, and so does this.
 */
export function planGuide(
  db: Database.Database,
  planId: string,
  now = Date.now(),
) {
  const meta = db
    .prepare(`SELECT exam_at, target, status FROM plans WHERE id = ?`)
    .get(planId) as
    { exam_at: number | null; target: number; status: string } | undefined;
  if (!meta || meta.status === "building") return null;
  syncGaps(db, planId, now);
  const steps = readSteps(db, planId);
  const gaps = db
    .prepare(
      `SELECT topic_id, severity FROM gaps WHERE plan_id = ? AND closed_at IS NULL`,
    )
    .all(planId) as Array<{ topic_id: string | null; severity: "severe" | "minor" | null }>;
  const lastStudied = db.prepare(
    `SELECT MAX(created_at) AS at FROM learning_events WHERE plan_id = ? AND topic_id = ?`,
  );
  const topics: TopicStatus[] = planMastery(db, planId, now).map((topic) => {
    const open = gaps.filter((gap) => gap.topic_id === topic.id);
    const last = lastStudied.get(planId, topic.id) as { at: number | null };
    return {
      id: topic.id,
      mastery: topic.mastery,
      dueCards: dueCards(db, planId, now, topic.id).length,
      // Only gaps Progress would call severe count as such; a minor reading is not a severe gap.
      severeGaps: open.filter(
        (gap) => gapSeverity(gap.severity, topic.mastery, meta.target) === "severe",
      ).length,
      daysIdle: last.at == null ? 0 : Math.max(0, -daysUntil(last.at, now)),
    };
  });
  const read = new Set(
    steps.filter((step) => step.activity === "lesson").map((step) => step.topicId),
  );
  const hasIntro = Boolean(
    db.prepare("SELECT 1 FROM items WHERE plan_id = ? AND kind = 'intro'").get(planId),
  );
  return {
    next: suggestStep({
      topics,
      steps,
      hasIntro,
      target: reachableTarget(meta.target),
      daysToExam: meta.exam_at == null ? null : daysUntil(meta.exam_at, now),
    }),
    hasIntro,
    topics: topics.map((topic) => ({
      topicId: topic.id,
      mastery: topic.mastery,
      read: read.has(topic.id),
      dueCards: topic.dueCards,
      gaps: gaps.filter((gap) => gap.topic_id === topic.id).length,
      suggested: topicSuggestion(topic, read.has(topic.id)),
    })),
  };
}

export function listSubjects(db: Database.Database) {
  return db
    .prepare(`SELECT id, name FROM subjects ORDER BY position, name, id`)
    .all() as Array<{
    id: string;
    name: string;
  }>;
}
