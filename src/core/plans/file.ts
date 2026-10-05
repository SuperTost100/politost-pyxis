import { planEducation, snapshotPlanEducation } from "./education";
import { markPlanImported } from "./views";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { uuidv7 } from "../../shared/ids";
import { cardReviewSchema } from "../../shared/card-schedule";
import { planFileSchema, type PlanFile } from "../../shared/plan-file";
import { putBlob, readBlob } from "../blobs";
import { validateGraph, type ConceptGraph } from "../maps/graph";

export type { PlanFile };

/** Payload keys that hold an ID from this plan; import remaps them and rejects dangling ones. */
const REFERENCE_KEYS = [
  "sourceId",
  "sourceIds",
  "passageId",
  "passageIds",
  "topicId",
  "planId",
  "scopeId",
  "cardId",
  "itemId",
  "exerciseId",
  "attemptId",
  "gapId",
];

/** Drops references to rows the file does not carry (deleted cards, detached sources) and keeps the rest of the event. */
function dropUnknownRefs(value: unknown, known: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => dropUnknownRefs(v, known));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]): [string, unknown][] => {
      if (!REFERENCE_KEYS.includes(key))
        return [[key, dropUnknownRefs(item, known)]];
      if (typeof item === "string") return known.has(item) ? [[key, item]] : [];
      if (Array.isArray(item))
        return [
          [key, item.filter((x) => typeof x !== "string" || known.has(x))],
        ];
      return [[key, item]];
    }),
  );
}

function clampTarget(value: number): number {
  if (!Number.isFinite(value)) return 0.75;
  return Math.min(1, Math.max(0.5, value));
}

export function exportPlan(
  db: Database.Database,
  planId: string,
  options?: {
    progress?: boolean;
    embed?: boolean;
    workspace?: string;
    /** SHR-08: the exporter's profile display name. Omitted when blank, never invented. */
    author?: string;
  },
): PlanFile {
  const plan = db
    .prepare(
      `SELECT title, exam_at, target, content_language, style FROM plans WHERE id = ?`,
    )
    .get(planId) as
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
    .prepare(
      `SELECT id, title, position, tree_json, grounding, archived_at FROM topics WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    position: number;
    tree_json: string | null;
    grounding: "sources" | "mixed" | "general" | null;
    archived_at: number | null;
  }>;
  const index = new Map(topics.map((topic, i) => [topic.id, i]));
  const nodes = db
    .prepare(
      `SELECT id, title, kind, position, topic_id FROM path_nodes WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    kind: PlanFile["nodes"][number]["kind"];
    position: number;
    topic_id: string | null;
  }>;
  const nodeIndex = new Map(nodes.map((node, i) => [node.id, i]));
  const cards = db
    .prepare(
      `SELECT c.id, c.front, c.back, c.topic_id, c.passage_id, c.grounding, c.suspended,
              (SELECT cr.rating FROM card_reviews cr
               WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS rating,
              (SELECT cr.state_json FROM card_reviews cr
               WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS state_json,
              (SELECT cr.reviewed_at FROM card_reviews cr
               WHERE cr.card_id = c.id ORDER BY cr.reviewed_at DESC, cr.rowid DESC LIMIT 1) AS reviewed_at
       FROM cards c WHERE c.plan_id = ? AND c.removed = 0 ORDER BY c.created_at`,
    )
    .all(planId) as Array<{
    id: string;
    passage_id: string | null;
    suspended: number;
    grounding: "sources" | "mixed" | "general" | null;
    front: string;
    back: string;
    topic_id: string | null;
    rating: string | null;
    state_json: string | null;
    reviewed_at: number | null;
  }>;
  const education = planEducation(db, planId);
  const content = exportContent(db, planId, index, options?.progress === true);
  const referencedSources = [
    ...new Set([
      ...(content.passages ?? []).flatMap((p) =>
        p.sourceId ? [p.sourceId] : [],
      ),
      ...(content.exercises ?? []).flatMap((e) =>
        e.sourceId ? [e.sourceId] : [],
      ),
    ]),
  ];
  const file: PlanFile = {
    version: 2,
    id: planId,
    createdAt: Date.now(),
    ...(options?.author ? { author: options.author } : {}),
    ...content,
    title: plan.title,
    topics: topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      position: topic.position,
      ...(topic.tree_json ? { tree: JSON.parse(topic.tree_json) } : {}),
      ...(topic.grounding ? { grounding: topic.grounding } : {}),
      ...(topic.archived_at != null ? { archived: true } : {}),
      passageIds: (
        db
          .prepare(
            "SELECT passage_id AS id FROM topic_passages WHERE topic_id=? ORDER BY passage_id",
          )
          .all(topic.id) as { id: string }[]
      ).map((row) => row.id),
    })),
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      position: node.position,
      topic: node.topic_id == null ? null : (index.get(node.topic_id) ?? null),
    })),
    cards: cards.map((card) => ({
      id: card.id,
      passageId: card.passage_id,
      ...(options?.progress ? { suspended: card.suspended === 1 } : {}),
      grounding: card.grounding ?? (card.passage_id ? "sources" : "general"),
      front: card.front,
      back: card.back,
      topic: card.topic_id == null ? null : (index.get(card.topic_id) ?? null),
      ...(options?.progress &&
      card.state_json &&
      card.rating != null &&
      card.reviewed_at != null
        ? {
            schedule: cardReviewSchema.parse({
              rating: card.rating,
              state: JSON.parse(card.state_json),
              at: card.reviewed_at,
            }),
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
      plan.style === "read" ||
      plan.style === "practice" ||
      plan.style === "decide"
        ? plan.style
        : "decide",
    ...(education ? { educationLevel: education } : {}),
    sources: (
      db
        .prepare(
          `SELECT s.id,s.kind,s.title, COALESCE(s.blob_sha,(SELECT json_extract(sd.tree_json, '$.sourceSha') FROM source_documents sd WHERE sd.source_id=s.id ORDER BY sd.version DESC LIMIT 1)) AS blob_sha, s.mime
           FROM sources s
           WHERE s.id IN (SELECT source_id FROM plan_sources WHERE plan_id = ?)
           OR s.id IN (${referencedSources.map(() => "?").join(",") || "NULL"})
           ORDER BY s.title`,
        )
        .all(planId, ...referencedSources) as Array<{
        id: string;
        kind: string;
        title: string;
        blob_sha: string | null;
        mime: string | null;
      }>
    ).map((source) => {
      const file = sourceFile(
        options?.workspace ?? "",
        source.blob_sha,
        options?.embed === true,
      );
      return {
        id: source.id,
        kind: source.kind,
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
            topic:
              event.topic_id == null
                ? null
                : (index.get(event.topic_id) ?? null),
            payload: exportedPayload(
              event.kind,
              JSON.parse(event.payload_json) as unknown,
              nodeIndex,
            ),
            at: event.created_at,
          })),
        }
      : {}),
  };
  if (file.progress) Object.assign(file, exportGapState(db, planId, index, file));
  if (file.progress) {
    // An event may name a card or source that is not exported (deleted, soft-removed, detached).
    // Import rejects dangling references, so drop only the reference and keep the evidence.
    const known = new Set(
      [
        file.id,
        ...file.topics.map((x) => x.id),
        ...file.nodes.map((x) => x.id),
        ...file.cards.map((x) => x.id),
        ...(file.sources ?? []).map((x) => x.id),
        ...(file.documents ?? []).map((x) => x.id),
        ...(file.passages ?? []).map((x) => x.id),
        ...(file.exercises ?? []).map((x) => x.id),
        ...(file.items ?? []).map((x) => x.id),
        ...(file.maps ?? []).map((x) => x.id),
        ...(file.gaps ?? []).map((x) => x.id),
        ...(file.attempts ?? []).map((x) => x.id),
      ].filter((id): id is string => typeof id === "string"),
    );
    file.progress = file.progress.map((event) => ({
      ...event,
      payload: dropUnknownRefs(event.payload, known),
    }));
  }
  return file;
}

/**
 * PRO-02 / PRO-08 gap state for a progress export: the gap rows, the submitted attempts that events or gap answers name,
 * the wrong answers each gap owns and its drill quiz. Gap events are cut down to one opened and one closed event per
 * exported gap, so a file never carries an event for a gap it does not contain. A flag-only gap that is still open is
 * left out: the flag it rests on does not travel.
 */
function exportGapState(
  db: Database.Database,
  planId: string,
  topicIndex: Map<string, number>,
  file: PlanFile,
): Pick<PlanFile, "gaps" | "attempts" | "gapAnswers" | "gapItems" | "progress" | "items"> {
  const itemQuestions = new Map<string, Set<string>>();
  const itemKind = new Map((file.items ?? []).map((item) => [item.id, item.kind]));
  for (const item of file.items ?? []) {
    const questions = (item.body as { questions?: Array<{ id?: unknown }> } | null)?.questions;
    itemQuestions.set(
      item.id,
      new Set((questions ?? []).flatMap((q) => (typeof q.id === "string" ? [q.id] : []))),
    );
  }
  const gapRows = db
    .prepare(
      `SELECT id, topic_id, opened_at, closed_at, origin, misconception, severity, comparison, merged_into
       FROM gaps WHERE plan_id = ? AND NOT (origin = 'flag' AND closed_at IS NULL) ORDER BY opened_at, id`,
    )
    .all(planId) as Array<{
    id: string;
    topic_id: string | null;
    opened_at: number;
    closed_at: number | null;
    origin: "answers" | "flag" | "misconception";
    misconception: string | null;
    severity: "severe" | "minor" | null;
    comparison: "unchecked" | null;
    merged_into: string | null;
  }>;
  const gapIds = new Set(gapRows.map((row) => row.id));
  const links = db
    .prepare(
      `SELECT ga.gap_id, ga.attempt_id, ga.question_id FROM gap_answers ga JOIN gaps g ON g.id = ga.gap_id
       WHERE g.plan_id = ? ORDER BY ga.attempt_id, ga.question_id, ga.gap_id`,
    )
    .all(planId) as Array<{ gap_id: string; attempt_id: string; question_id: string }>;
  const named = new Set(links.map((row) => row.attempt_id));
  for (const event of file.progress ?? []) {
    const attemptId = (event.payload as { attemptId?: unknown } | null)?.attemptId;
    if (typeof attemptId === "string") named.add(attemptId);
  }
  const attempts = (
    db
      .prepare(
        `SELECT id, item_id, started_at, submitted_at FROM attempts
         WHERE plan_id = ? AND submitted_at IS NOT NULL ORDER BY started_at, id`,
      )
      .all(planId) as Array<{ id: string; item_id: string | null; started_at: number; submitted_at: number }>
  )
    .filter((row) => named.has(row.id))
    .map((row) => ({
      id: row.id,
      item: row.item_id && ["quiz", "diagnostic", "simulation"].includes(itemKind.get(row.item_id) ?? "") ? row.item_id : null,
      startedAt: row.started_at,
      submittedAt: row.submitted_at,
    }));
  const attemptItem = new Map(attempts.map((row) => [row.id, row.item]));
  const reasons = new Map<string, string>();
  for (const event of file.progress ?? []) {
    const { gapId, reason } = (event.payload ?? {}) as { gapId?: unknown; reason?: unknown };
    if (event.kind === "gap_closed" && typeof gapId === "string" && (reason === "answers" || reason === "flag"))
      reasons.set(gapId, reason);
  }
  return {
    // An adopted review question names the gap it was built for; a gap the file leaves out is not named.
    items: (file.items ?? []).map((item) => ({ ...item, body: withoutGapIds(item.body, gapIds) })),
    gaps: gapRows.map((row) => ({
      id: row.id,
      topic: row.topic_id == null ? null : (topicIndex.get(row.topic_id) ?? null),
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      origin: row.origin,
      misconception: row.misconception,
      severity: row.severity,
      comparison: row.comparison,
      mergedInto: row.merged_into && gapIds.has(row.merged_into) && row.closed_at != null ? row.merged_into : null,
    })),
    attempts,
    // An attempt whose quiz is gone cannot show its question, so its links go with it.
    gapAnswers: links.flatMap((row) => {
      const item = attemptItem.get(row.attempt_id);
      return gapIds.has(row.gap_id) && item && itemQuestions.get(item)?.has(row.question_id)
        ? [{ gap: row.gap_id, attempt: row.attempt_id, question: row.question_id }]
        : [];
    }),
    gapItems: (
      db
        .prepare(
          `SELECT gi.gap_id, gi.item_id FROM gap_items gi JOIN gaps g ON g.id = gi.gap_id
           WHERE g.plan_id = ? ORDER BY gi.gap_id, gi.item_id`,
        )
        .all(planId) as Array<{ gap_id: string; item_id: string }>
    ).flatMap((row) =>
      gapIds.has(row.gap_id) && ["quiz", "diagnostic"].includes(itemKind.get(row.item_id) ?? "")
        ? [{ gap: row.gap_id, item: row.item_id }]
        : [],
    ),
    // Gap events are written from the rows, so each exported gap has exactly one opened and one closed event that agree
    // with it, whatever the database holds (a legacy gap may have none). The close reason is kept unless it contradicts
    // the merge target.
    progress: [
      ...(file.progress ?? []).filter((event) => event.kind !== "gap_opened" && event.kind !== "gap_closed"),
      ...gapRows.flatMap((row) => {
        const topic = row.topic_id == null ? null : (topicIndex.get(row.topic_id) ?? null);
        const into = row.merged_into && gapIds.has(row.merged_into) && row.closed_at != null ? row.merged_into : null;
        const opened = { kind: "gap_opened" as const, topic, payload: { gapId: row.id, origin: row.origin }, at: row.opened_at };
        if (row.closed_at == null) return [opened];
        const reason = into ? "merged" : (reasons.get(row.id) ?? "answers");
        return [
          opened,
          { kind: "gap_closed" as const, topic, payload: { gapId: row.id, reason, ...(into ? { into } : {}) }, at: row.closed_at },
        ];
      }),
    ].sort((a, b) => a.at - b.at),
  };
}

function withoutGapIds(value: unknown, known: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutGapIds(v, known));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]): [string, unknown][] =>
      key === "gapId" ? (typeof item === "string" && known.has(item) ? [[key, item]] : []) : [[key, withoutGapIds(item, known)]],
    ),
  );
}

function exportedPayload(
  kind: string,
  payload: unknown,
  nodeIndex: Map<string, number>,
): unknown {
  if (kind !== "lesson_completed") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
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

/**
 * The items a file may carry. A review session is only the live queue. What the student's mistakes produced travels
 * only with progress: a gap drill (its explanation is written from their wrong answers) and a finished review
 * (submitted attempt), which then travels as a quiz so attempts and adopted questions have something to point at.
 * Parameters: the progress flag twice.
 */
const portableItems = `kind != 'review_session'
  AND (? OR id NOT IN (SELECT item_id FROM gap_items))
  AND (kind != 'review' OR (? AND EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = items.id AND a.submitted_at IS NOT NULL)))`;

const isGapEvent = (kind: string) => kind === "gap_opened" || kind === "gap_closed";

/** An old file's attempt and gap IDs point into the exporter's database, so they are not kept. */
function withoutLegacyRefs(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { attemptId: _attempt, gapId: _gap, ...rest } = payload as Record<string, unknown>;
  return rest;
}

function importedPayload(
  kind: string,
  payload: unknown,
  nodeIds: string[],
): unknown {
  if (kind !== "lesson_completed") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
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
    return {
      bytes,
      data: Buffer.from(readFileSync(record.file)).toString("base64"),
    };
  } catch {
    return { bytes: 0 };
  }
}

function decodeSource(data: string, bytes: number): Buffer {
  if (
    data !== "" &&
    (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
  ) {
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
  if (parsed.version === 2)
    return importPortablePlan(db, parsed, now, workspace);
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
    markPlanImported(db, planId, now, {
      ...(parsed.author ? { author: parsed.author } : {}),
      ...(parsed.createdAt != null ? { exportedAt: parsed.createdAt } : {}),
    });
    snapshotPlanEducation(db, planId, parsed.educationLevel, now);
    parsed.topics.forEach((topic, i) => {
      db.prepare(
        `INSERT INTO topics (id, plan_id, title, position, grounding, archived_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        topicIds[i],
        planId,
        topic.title,
        topic.position,
        topic.grounding ?? null,
        topic.archived ? now : null,
        now,
      );
    });
    parsed.nodes.forEach((node, i) => {
      const topicId = topicRef(topicIds, node.topic);
      db.prepare(
        `INSERT INTO path_nodes (id, plan_id, topic_id, kind, position, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        nodeIds[i],
        planId,
        topicId,
        node.kind,
        node.position,
        node.title,
        now,
      );
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
    // A version 1 file carries neither gap rows nor attempts: gap events are dropped and replayed from the answers.
    (parsed.progress ?? []).filter((event) => !isGapEvent(event.kind)).forEach((event, i) => {
      const topicId = topicRef(topicIds, event.topic);
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        uuidv7(now + 300 + i),
        event.kind,
        planId,
        topicId,
        JSON.stringify(
          withoutLegacyRefs(importedPayload(event.kind, event.payload, nodeIds)) ?? {},
        ),
        event.at,
      );
    });
    embedded.forEach((source, i) => {
      putBlob(
        workspace,
        source.bytes,
        source.mime ?? "application/octet-stream",
        "bin",
      );
      const sourceId = uuidv7(now + 500 + i);
      db.prepare(
        `INSERT INTO sources (id, kind, title, blob_sha, mime, status, created_at, updated_at)
         VALUES (?, 'file', ?, ?, ?, 'ready', ?, ?)`,
      ).run(sourceId, source.title, source.sha, source.mime, now, now);
      db.prepare(
        `INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)`,
      ).run(planId, sourceId);
    });
  });
  run();
  return planId;
}

function portableQuestionIds(itemId: string, body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.questions)) return body;
  return {
    ...record,
    questions: record.questions.map((question: unknown, index: number) => {
      if (!question || typeof question !== "object" || Array.isArray(question))
        return question;
      const value = question as Record<string, unknown>;
      if (value.id !== undefined) return question;
      const digest = createHash("sha256")
        .update(JSON.stringify([itemId, index]))
        .digest("hex");
      return { ...value, id: `pyxis-question-${digest.slice(0, 32)}` };
    }),
  };
}

function cleanContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanContent);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "picks",
            "draft",
            "result",
            "results",
            "checked",
            "gradingStartedAt",
            "gradingJobId",
            "submittedAt",
            "jobId",
            "picked",
          ].includes(key),
      )
      .map(([key, item]) => [key, cleanContent(item)]),
  );
}
function exportContent(
  db: Database.Database,
  planId: string,
  topicIndex: Map<string, number>,
  progress: boolean,
) {
  const passages = db
    .prepare(
      `SELECT DISTINCT p.*,COALESCE(s.blob_sha,json_extract(sd.tree_json, '$.sourceSha')) AS blob_sha FROM passages p LEFT JOIN sources s ON s.id=p.source_id LEFT JOIN source_documents sd ON sd.id=p.document_id WHERE p.id IN (SELECT tp.passage_id FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=? UNION SELECT ip.passage_id FROM item_passages ip WHERE ip.item_id IN (SELECT id FROM items WHERE plan_id=? AND ${portableItems}) UNION SELECT passage_id FROM cards WHERE plan_id=? AND removed=0 AND passage_id IS NOT NULL) ORDER BY p.id`,
    )
    .all(planId, planId, progress ? 1 : 0, progress ? 1 : 0, planId) as {
    id: string;
    source_id: string | null;
    document_id: string | null;
    version: number;
    text: string;
    locator_json: string | null;
    section_path: string | null;
    char_start: number | null;
    char_end: number | null;
    blob_sha: string | null;
  }[];
  const citedIds = new Set<string>();
  function citations(value: unknown, key = "") {
    if (Array.isArray(value))
      return value.forEach((item) => citations(item, key));
    if (value && typeof value === "object")
      return Object.entries(value).forEach(([name, item]) =>
        citations(item, name),
      );
    if (
      typeof value === "string" &&
      ["sources", "sourceIds", "sourceId", "passageIds", "passageId"].includes(
        key,
      )
    )
      citedIds.add(value);
    if (typeof value === "string") {
      for (const match of value.matchAll(/:::exercise\{[^}\n]*\bid="(.*?)"/g))
        citedIds.add(match[1]!);
    }
    if (typeof value === "string" && key === "cacheKey") {
      try {
        citations(JSON.parse(value));
      } catch {
        /* Old non-JSON cache keys have no passage references. */
      }
    }
  }
  for (const row of db
    .prepare(
      `SELECT body_json AS content FROM items WHERE plan_id=? AND ${portableItems} UNION ALL SELECT graph_json AS content FROM maps WHERE plan_id=?`,
    )
    .all(planId, progress ? 1 : 0, progress ? 1 : 0, planId) as { content: string }[])
    citations(JSON.parse(row.content));
  const citedExerciseIds = [...citedIds];
  const exercisePassages = db
    .prepare(
      `SELECT e.passage_id AS id FROM exercises e LEFT JOIN smartbooks sb ON sb.id=e.smartbook_id WHERE e.passage_id IS NOT NULL AND (sb.source_id IN (SELECT source_id FROM plan_sources WHERE plan_id=?) OR json_extract(e.locator_json,'$.planId')=? OR e.id IN (${citedExerciseIds.map(() => "?").join(",") || "NULL"}))`,
    )
    .all(planId, planId, ...citedExerciseIds) as { id: string }[];
  for (const passage of exercisePassages) citedIds.add(passage.id);
  const knownPassages = new Set(passages.map((p) => p.id));
  for (const id of citedIds) {
    if (knownPassages.has(id)) continue;
    const passage = db
      .prepare(
        "SELECT p.*,COALESCE(s.blob_sha,json_extract(sd.tree_json, '$.sourceSha')) AS blob_sha FROM passages p LEFT JOIN sources s ON s.id=p.source_id LEFT JOIN source_documents sd ON sd.id=p.document_id WHERE p.id=?",
      )
      .get(id) as (typeof passages)[number] | undefined;
    if (passage) {
      passages.push(passage);
      knownPassages.add(id);
    }
  }
  passages.sort((a, b) => a.id.localeCompare(b.id));
  const documentIds = [
    ...new Set(passages.flatMap((p) => (p.document_id ? [p.document_id] : []))),
  ];
  const documents = documentIds.map((id) => {
    const row = db
      .prepare(
        "SELECT id,source_id,version,tree_json FROM source_documents WHERE id=?",
      )
      .get(id) as {
      id: string;
      source_id: string;
      version: number;
      tree_json: string;
    };
    const tree = JSON.parse(row.tree_json) as Record<string, unknown>;
    delete tree.blobSha;
    return { id: row.id, sourceId: row.source_id, version: row.version, tree };
  });
  const items = (
    db
      .prepare(`SELECT * FROM items WHERE plan_id=? AND ${portableItems} ORDER BY created_at,id`)
      .all(planId, progress ? 1 : 0, progress ? 1 : 0) as {
      id: string;
      topic_id: string | null;
      kind: "lesson" | "intro" | "diagnostic" | "quiz" | "simulation" | "review";
      body_json: string;
      grounding: "sources" | "mixed" | "general" | null;
      engine_provider: string | null;
      model_id: string | null;
    }[]
  ).map((row) => {
    const passageIds = (
      db
        .prepare(
          "SELECT ip.passage_id AS id FROM item_passages ip JOIN passages p ON p.id=ip.passage_id WHERE ip.item_id=? ORDER BY p.created_at,p.id",
        )
        .all(row.id) as { id: string }[]
    ).map((p) => p.id);
    let body = portableQuestionIds(
      row.id,
      cleanContent(JSON.parse(row.body_json)),
    );
    // Carry legacy prose citation order before import assigns fresh passage IDs.
    if (
      (row.kind === "lesson" || row.kind === "intro") &&
      body &&
      typeof body === "object" &&
      !Array.isArray((body as { passageIds?: unknown }).passageIds)
    ) {
      body = { ...body, passageIds };
    }
    return {
      id: row.id,
      topic:
        row.topic_id == null ? null : (topicIndex.get(row.topic_id) ?? null),
      kind: row.kind === "review" ? ("quiz" as const) : row.kind,
      body,
      passageIds,
      grounding: row.grounding,
      provider: row.engine_provider,
      model: row.model_id,
    };
  });
  const exercises = (
    db
      .prepare(
        `SELECT e.*,sb.source_id FROM exercises e LEFT JOIN smartbooks sb ON sb.id=e.smartbook_id WHERE sb.source_id IN (SELECT source_id FROM plan_sources WHERE plan_id=?) OR e.passage_id IN (SELECT tp.passage_id FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=?) OR json_extract(e.locator_json,'$.planId')=? OR e.id IN (${[...citedIds].map(() => "?").join(",") || "NULL"}) ORDER BY e.created_at,e.id`,
      )
      .all(planId, planId, planId, ...citedIds) as {
      id: string;
      source_id: string | null;
      passage_id: string | null;
      prompt: string;
      answer: string | null;
      locator_json: string | null;
      grounding: "sources" | "mixed" | "general" | null;
    }[]
  ).map((e) => ({
    id: e.id,
    sourceId: e.source_id,
    passageId: e.passage_id,
    prompt: e.prompt,
    answer: e.answer,
    locator: e.locator_json ? JSON.parse(e.locator_json) : null,
    grounding: e.grounding,
  }));
  const maps = (
    db
      .prepare(
        "SELECT id,topic_id,graph_json FROM maps WHERE plan_id=? ORDER BY created_at,id",
      )
      .all(planId) as {
      id: string;
      topic_id: string | null;
      graph_json: string;
    }[]
  ).map((row) => {
    const value = JSON.parse(row.graph_json) as {
      version?: number;
      maps?: unknown[];
      nodes?: { label: string; parent: string | null; sources?: string[] }[];
    };
    return {
      id: row.id,
      topic:
        row.topic_id == null ? null : (topicIndex.get(row.topic_id) ?? null),
      entries:
        value.version === 1
          ? (value.maps ?? [])
          : [
              {
                id: row.id,
                title:
                  value.nodes?.find((n) => n.parent === null)?.label ?? "Map",
                passageIds: [
                  ...new Set(
                    value.nodes?.flatMap((n) => n.sources ?? []) ?? [],
                  ),
                ],
                graph: value,
              },
            ],
    };
  });
  return {
    passages: passages.map((p) => ({
      id: p.id,
      sourceId: p.source_id,
      documentId: p.document_id,
      version: p.version,
      text: p.text,
      locator: p.locator_json ? JSON.parse(p.locator_json) : null,
      section: p.section_path,
      charStart: p.char_start,
      charEnd: p.char_end,
      textSha: createHash("sha256").update(p.text).digest("hex"),
      sourceSha: p.blob_sha,
    })),
    documents,
    items,
    exercises,
    maps,
  } as Pick<
    PlanFile,
    "passages" | "documents" | "items" | "exercises" | "maps"
  >;
}
function importPortablePlan(
  db: Database.Database,
  file: PlanFile,
  now: number,
  workspace: string,
): string {
  file = {
    ...file,
    items: file.items?.map((item) => ({
      ...item,
      body: portableQuestionIds(item.id, item.body),
    })),
  };
  const ids = new Map<string, string>();
  let sequence = 0;
  const allocate = (old: string | undefined) => {
    const value = uuidv7(now + sequence++);
    if (old) {
      if (ids.has(old)) throw new Error("plan-file");
      ids.set(old, value);
    }
    return value;
  };
  const ref = (old: string | null | undefined) => {
    if (old == null) return null;
    const id = ids.get(old);
    if (!id) throw new Error("plan-file");
    return id;
  };
  const sourceKeys = new Set(
    (file.sources ?? []).flatMap((s) => (s.id ? [s.id] : [])),
  );
  const passageKeys = new Set((file.passages ?? []).map((p) => p.id));
  const documentKeys = new Set((file.documents ?? []).map((d) => d.id));
  function checkedRef(
    old: string | null | undefined,
    keys: Set<string>,
  ): string | null {
    if (old != null && !keys.has(old)) throw new Error("plan-file");
    return ref(old);
  }
  const planId = allocate(file.id);
  const topicIds = file.topics.map((t) => allocate(t.id));
  const nodeIds = file.nodes.map((n) => allocate(n.id));
  const sourceIds = (file.sources ?? []).map((s) => allocate(s.id));
  const documentIds = (file.documents ?? []).map((d) => allocate(d.id));
  const passageIds = (file.passages ?? []).map((p) => allocate(p.id));
  const exerciseIds = (file.exercises ?? []).map((e) => allocate(e.id));
  const itemIds = (file.items ?? []).map((i) => allocate(i.id));
  const cardIds = file.cards.map((c) => allocate(c.id));
  // Gap state is optional. A file without `gaps` or `attempts` has no such IDs, so references to them are dropped
  // and the gaps are replayed from the answers; a file with them must name only rows it carries.
  const gapAware = file.gaps !== undefined;
  const attemptAware = file.attempts !== undefined;
  const gapIds = (file.gaps ?? []).map((g) => allocate(g.id));
  const attemptIds = (file.attempts ?? []).map((a) => allocate(a.id));
  const mapIds = (file.maps ?? []).map((m) => allocate(m.id));
  const entryKeys = new Set<string>();
  for (const m of file.maps ?? []) {
    for (const entry of m.entries) {
      if (entryKeys.has(entry.id) || (ids.has(entry.id) && entry.id !== m.id))
        throw new Error("plan-file");
      entryKeys.add(entry.id);
      if (!ids.has(entry.id)) allocate(entry.id);
    }
  }
  for (const item of file.items ?? []) {
    const body = item.body as { questions?: { id?: string }[] };
    for (const q of body.questions ?? [])
      if (q.id && !ids.has(q.id)) allocate(q.id);
  }
  const embedded = new Map<number, Buffer>();
  (file.sources ?? []).forEach((source, i) => {
    if (source.data !== undefined) {
      if (!workspace) throw new Error("plan-file");
      const bytes = decodeSource(source.data, source.bytes);
      if (
        source.sha &&
        createHash("sha256").update(bytes).digest("hex") !== source.sha
      )
        throw new Error("plan-file");
      embedded.set(i, bytes);
    }
  });
  // The original file's hash for each source: an embedded file's own bytes, otherwise what the file's source list says.
  // A document's own hash fields are never trusted, so a forged one cannot make an unrelated file look like the original.
  const originalSha = new Map<string, string | null>();
  (file.sources ?? []).forEach((s, i) => {
    const bytes = embedded.get(i);
    if (s.id) originalSha.set(s.id, bytes ? createHash("sha256").update(bytes).digest("hex") : s.sha);
  });
  function remap(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((item) => remap(item, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([k]) =>
              !(k === "gapId" && !gapAware) && !(k === "attemptId" && !attemptAware),
          )
          .map(([k, item]) => [k, remap(item, k)]),
      );
    if (typeof value === "string") {
      if (key === "cacheKey") {
        let cache: unknown;
        try {
          cache = JSON.parse(value);
        } catch {
          throw new Error("plan-file");
        }
        return JSON.stringify(remap(cache));
      }
      if (key === "id" || key === "nodeId") return ids.get(value) ?? value;
      if (REFERENCE_KEYS.includes(key)) return ref(value);
      return value.replace(
        /(:::exercise\{[^}\n]*\bid=")(.*?)(")/g,
        (whole: string, start: string, id: string, end: string) =>
          ids.has(id) ? `${start}${ref(id)}${end}` : whole,
      );
    }
    return value;
  }
  const mapGraph = (graph: ConceptGraph) => {
    validateGraph(graph);
    if (graph.undo)
      validateGraph({
        ...graph,
        nodes: graph.undo.nodes,
        edges: graph.undo.edges,
        undo: null,
      });
    if (graph.redo)
      validateGraph({
        ...graph,
        nodes: graph.redo.nodes,
        edges: graph.redo.edges,
        undo: null,
        redo: null,
      });
    const locals = new Map<string, string>();
    for (const node of [
      ...graph.nodes,
      ...(graph.undo?.nodes ?? []),
      ...(graph.redo?.nodes ?? []),
    ])
      if (!locals.has(node.id)) locals.set(node.id, uuidv7(now + sequence++));
    const part = (
      nodes: ConceptGraph["nodes"],
      edges: ConceptGraph["edges"],
    ) => ({
      nodes: nodes.map((n) => ({
        ...n,
        id: locals.get(n.id)!,
        parent: n.parent == null ? null : locals.get(n.parent)!,
        sources: n.sources?.map((id) => checkedRef(id, passageKeys)!),
      })),
      edges: edges.map((e) => ({
        ...e,
        from: locals.get(e.from)!,
        to: locals.get(e.to)!,
      })),
    });
    return {
      ...graph,
      ...part(graph.nodes, graph.edges),
      undo: graph.undo
        ? {
            ...part(graph.undo.nodes, graph.undo.edges),
            layout: graph.undo.layout,
          }
        : null,
      redo: graph.redo
        ? {
            ...part(graph.redo.nodes, graph.redo.edges),
            layout: graph.redo.layout,
          }
        : null,
    };
  };
  // Validate every reference and prepare content before writing database rows or blobs.
  const topics = file.topics.map((t) => ({
    ...t,
    tree: t.tree ? remap(t.tree) : null,
    passageIds: t.passageIds?.map((id) => checkedRef(id, passageKeys)!),
  }));
  const documentVersions = new Set<string>();
  const documents = (file.documents ?? []).map((d) => {
    const key = JSON.stringify([d.sourceId, d.version]);
    if (documentVersions.has(key)) throw new Error("plan-file");
    documentVersions.add(key);
    return {
      ...d,
      sourceId: checkedRef(d.sourceId, sourceKeys)!,
      tree: remap(d.tree),
    };
  });
  // Looked up once per passage, source and document, so the first entry with an ID wins as it did with `.find`.
  const firstById = <T extends { id?: string | undefined }>(rows: T[]) => {
    const byId = new Map<string, T>();
    for (const row of rows) if (row.id != null && !byId.has(row.id)) byId.set(row.id, row);
    return byId;
  };
  const sourcesById = firstById(file.sources ?? []);
  const documentsById = firstById(file.documents ?? []);
  const passages = (file.passages ?? []).map((p) => {
    if (createHash("sha256").update(p.text).digest("hex") !== p.textSha)
      throw new Error("plan-file");
    const source = p.sourceId == null ? undefined : sourcesById.get(p.sourceId);
    if (p.sourceSha && source?.sha !== p.sourceSha)
      throw new Error("plan-file");
    const document = p.documentId == null ? undefined : documentsById.get(p.documentId);
    if (
      document &&
      (document.sourceId !== p.sourceId || document.version !== p.version)
    )
      throw new Error("plan-file");
    return {
      ...p,
      sourceId: checkedRef(p.sourceId, sourceKeys),
      documentId: checkedRef(p.documentId, documentKeys),
    };
  });
  const exercises = (file.exercises ?? []).map((e) => {
    const { planId: _stale, ...locator } = (
      e.locator && typeof e.locator === "object" && !Array.isArray(e.locator)
        ? e.locator
        : {}
    ) as Record<string, unknown>;
    // A book exercise whose source was skipped has no smartbook row. Tie it to this plan so topicExercises still finds it by chapter.
    const detachedBook =
      e.sourceId == null &&
      locator.kind !== "generated" &&
      typeof locator.chapter === "number";
    return {
      ...e,
      sourceId: checkedRef(e.sourceId, sourceKeys),
      passageId: checkedRef(e.passageId, passageKeys),
      locator: {
        ...(remap(locator) as object),
        ...(detachedBook ? { planId } : {}),
      },
    };
  });
  const items = (file.items ?? []).map((i) => ({
    ...i,
    topicId: topicRef(topicIds, i.topic),
    body: remap(cleanContent(i.body)),
    passageIds: i.passageIds.map((id) => checkedRef(id, passageKeys)!),
  }));
  const cards = file.cards.map((c) => ({
    ...c,
    topicId: topicRef(topicIds, c.topic),
    passageId: checkedRef(c.passageId, passageKeys),
  }));
  const maps = (file.maps ?? []).map((m) => ({
    ...m,
    topicId: topicRef(topicIds, m.topic),
    entries: m.entries.map((e) => ({
      ...e,
      id: ref(e.id)!,
      passageIds: e.passageIds.map((id) => checkedRef(id, passageKeys)!),
      graph: mapGraph(e.graph),
    })),
  }));
  file.nodes.forEach((n) => topicRef(topicIds, n.topic));
  // Gap state: every reference is checked here, before anything is written.
  if (!gapAware && (file.gapAnswers?.length || file.gapItems?.length))
    throw new Error("plan-file");
  const gapRows = file.gaps ?? [];
  const gapByOld = new Map(gapRows.map((g) => [g.id, g]));
  const attemptRows = file.attempts ?? [];
  const attemptByOld = new Map(attemptRows.map((a) => [a.id, a]));
  const questionsOfItem = new Map(
    (file.items ?? []).map((item) => [
      item.id,
      new Set(
        ((item.body as { questions?: Array<{ id?: string }> }).questions ?? []).flatMap((q) =>
          q.id ? [q.id] : [],
        ),
      ),
    ]),
  );
  // Linear: each gap is validated once, and a chain is followed with an explicit path instead of recursion. A gap on
  // the current path that is reached again is a loop; a gap already finished is known to end well.
  const finished = new Set<(typeof gapRows)[number]>();
  for (const start of gapRows) {
    const path = new Set<(typeof gapRows)[number]>();
    for (let g: (typeof gapRows)[number] | undefined = start; g && !finished.has(g); ) {
      if (path.has(g)) throw new Error("plan-file");
      path.add(g);
      topicRef(topicIds, g.topic);
      if (g.closedAt != null && g.closedAt < g.openedAt) throw new Error("plan-file");
      if (g.mergedInto == null) break;
      const into = gapByOld.get(g.mergedInto);
      // A gap is absorbed only once it is closed, by another gap of the same topic.
      if (!into || into === g || g.closedAt == null || into.topic !== g.topic)
        throw new Error("plan-file");
      g = into;
    }
    path.forEach((g) => finished.add(g));
  }
  const itemKind = new Map((file.items ?? []).map((item) => [item.id, item.kind]));
  for (const a of attemptRows) {
    // An attempt may have lost its quiz (item null); one that names an item names a quiz, diagnostic or simulation.
    if (a.item != null && !["quiz", "diagnostic", "simulation"].includes(itemKind.get(a.item) ?? ""))
      throw new Error("plan-file");
    if (a.submittedAt < a.startedAt) throw new Error("plan-file");
  }
  const once = new Set<string>();
  for (const link of file.gapAnswers ?? []) {
    const attempt = attemptByOld.get(link.attempt);
    const key = JSON.stringify([link.gap, link.attempt, link.question]);
    if (
      !gapByOld.has(link.gap) ||
      !attempt?.item ||
      !questionsOfItem.get(attempt.item)?.has(link.question) ||
      once.has(key)
    )
      throw new Error("plan-file");
    once.add(key);
  }
  for (const link of file.gapItems ?? []) {
    const key = JSON.stringify([link.gap, link.item]);
    // A drill is a quiz or diagnostic; a lesson or simulation is not a gap drill.
    if (
      !gapByOld.has(link.gap) ||
      !["quiz", "diagnostic"].includes(itemKind.get(link.item) ?? "") ||
      once.has(key)
    )
      throw new Error("plan-file");
    once.add(key);
  }
  const opened = new Set<string>();
  const closed = new Set<string>();
  const progress = (file.progress ?? []).flatMap((e) => {
    let payload: unknown = e.payload;
    if (isGapEvent(e.kind)) {
      // Without gap rows the replay writes these events itself, once, with the new IDs.
      if (!gapAware) return [];
      const record = (payload ?? {}) as { gapId?: unknown; into?: unknown; reason?: unknown; origin?: unknown };
      const old = typeof record.gapId === "string" ? record.gapId : "";
      const gap = gapByOld.get(old);
      const seen = e.kind === "gap_opened" ? opened : closed;
      // The event must say what the row says: same gap, topic and time, written once.
      if (!gap || seen.has(old) || e.topic !== gap.topic) throw new Error("plan-file");
      seen.add(old);
      if (e.kind === "gap_opened") {
        if (record.into !== undefined || e.at !== gap.openedAt || (record.origin ?? gap.origin) !== gap.origin)
          throw new Error("plan-file");
        payload = { gapId: ref(old), origin: gap.origin };
      } else {
        const merged = record.reason === "merged";
        if (
          gap.closedAt == null ||
          e.at !== gap.closedAt ||
          (merged
            ? gap.mergedInto == null || record.into !== gap.mergedInto
            : (record.reason !== "answers" && record.reason !== "flag") ||
              record.into !== undefined ||
              gap.mergedInto != null)
        )
          throw new Error("plan-file");
        payload = {
          gapId: ref(old),
          reason: record.reason,
          ...(gap.mergedInto != null ? { into: ref(gap.mergedInto) } : {}),
        };
      }
      return [{ ...e, topicId: topicRef(topicIds, e.topic), payload }];
    }
    payload = remap(importedPayload(e.kind, payload, nodeIds));
    return [{ ...e, topicId: topicRef(topicIds, e.topic), payload }];
  });
  // A file with gap rows carries exactly one opened event per gap and one closed event per closed gap.
  for (const g of gapRows)
    if (!opened.has(g.id) || (g.closedAt != null && !closed.has(g.id))) throw new Error("plan-file");
  return db.transaction(() => {
    db.prepare(
      "INSERT INTO plans(id,title,status,content_language,exam_at,target,style,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      planId,
      file.title,
      // PLAN-11: a plan whose active topics are all general knowledge stays a draft after import.
      file.topics.some((t) => !t.archived) &&
        file.topics.every((t) => t.archived || t.grounding === "general")
        ? "draft"
        : "ready",
      file.language ?? null,
      file.examAt ?? null,
      file.target ?? 0.75,
      file.style ?? "decide",
      now,
      now,
    );
    markPlanImported(db, planId, now, {
      ...(file.author ? { author: file.author } : {}),
      ...(file.createdAt != null ? { exportedAt: file.createdAt } : {}),
    });
    snapshotPlanEducation(db, planId, file.educationLevel, now);
    topics.forEach((t, i) => {
      db.prepare(
        "INSERT INTO topics(id,plan_id,title,position,tree_json,grounding,archived_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        topicIds[i],
        planId,
        t.title,
        t.position,
        t.tree ? JSON.stringify(t.tree) : null,
        t.grounding ?? null,
        t.archived ? now : null,
        now,
      );
    });
    const exerciseSources = new Set(exercises.map((e) => e.sourceId));
    const documentBySource = new Map<string, (typeof documents)[number]>();
    for (const d of documents)
      if (!documentBySource.has(d.sourceId)) documentBySource.set(d.sourceId, d);
    const sourceIndex = new Map<string, number>();
    (file.sources ?? []).forEach((s, i) => {
      if (s.id != null && !sourceIndex.has(s.id)) sourceIndex.set(s.id, i);
    });
    (file.sources ?? []).forEach((s, i) => {
      const bytes = embedded.get(i);
      const sha = bytes
        ? putBlob(workspace, bytes, s.mime ?? "application/octet-stream", "bin")
        : null;
      db.prepare(
        "INSERT INTO sources(id,kind,title,blob_sha,mime,status,library,created_at,updated_at) VALUES(?,?,?,?,?,'ready',0,?,?)",
      ).run(
        sourceIds[i],
        bytes ? (s.kind ?? "file") : "excerpt",
        s.title,
        sha,
        s.mime ?? null,
        now,
        now,
      );
      db.prepare("INSERT INTO plan_sources(plan_id,source_id) VALUES(?,?)").run(
        planId,
        sourceIds[i],
      );
      const hasExercise = exerciseSources.has(sourceIds[i]!);
      if (hasExercise || s.kind === "smartbook")
        db.prepare(
          "INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES(?,?,?,?)",
        ).run(
          uuidv7(now + sequence++),
          sourceIds[i],
          JSON.stringify({
            title: s.title,
            chapters: bytes
              ? ((
                  documentBySource.get(sourceIds[i]!)?.tree as
                    { chapters?: unknown[] } | undefined
                )?.chapters ?? [])
              : [],
          }),
          now,
        );
    });
    documents.forEach((d, i) => {
      const original = (file.documents ?? [])[i]!.sourceId;
      const { blobSha: _forged, ...tree } = d.tree as Record<string, unknown>;
      db.prepare(
        "INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,?,?,?)",
      ).run(
        documentIds[i],
        d.sourceId,
        d.version,
        JSON.stringify({
          ...tree,
          sourceSha: originalSha.get(original) ?? null,
          kind: embedded.has(sourceIndex.get(original) ?? -1)
            ? (file.sources ?? [])[sourceIndex.get(original)!]?.kind
            : "excerpt",
        }),
        now,
      );
    });
    passages.forEach((p, i) =>
      db
        .prepare(
          "INSERT INTO passages(id,source_id,document_id,version,text,locator_json,section_path,char_start,char_end,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          passageIds[i],
          p.sourceId,
          p.documentId,
          p.version,
          p.text,
          JSON.stringify(p.locator),
          p.section,
          p.charStart,
          p.charEnd,
          now,
        ),
    );
    topics.forEach((t, i) =>
      t.passageIds?.forEach((id) =>
        db
          .prepare(
            "INSERT INTO topic_passages(topic_id,passage_id) VALUES(?,?)",
          )
          .run(topicIds[i], id),
      ),
    );
    file.nodes.forEach((n, i) =>
      db
        .prepare(
          "INSERT INTO path_nodes(id,plan_id,topic_id,kind,position,title,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          nodeIds[i],
          planId,
          topicRef(topicIds, n.topic),
          n.kind,
          n.position,
          n.title,
          now,
        ),
    );
    exercises.forEach((e, i) => {
      const book = e.sourceId
        ? (db
            .prepare("SELECT id FROM smartbooks WHERE source_id=?")
            .get(e.sourceId) as { id: string } | undefined)
        : undefined;
      db.prepare(
        "INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        exerciseIds[i],
        book?.id ?? null,
        e.passageId,
        e.prompt,
        e.answer,
        JSON.stringify(e.locator),
        e.grounding,
        now,
      );
    });
    items.forEach((item, i) => {
      db.prepare(
        "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,model_id,grounding,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        itemIds[i],
        planId,
        item.topicId,
        item.kind,
        JSON.stringify(item.body),
        item.provider,
        item.model,
        item.grounding,
        now,
      );
      item.passageIds.forEach((id) =>
        db
          .prepare("INSERT INTO item_passages(item_id,passage_id) VALUES(?,?)")
          .run(itemIds[i], id),
      );
    });
    gapRows.forEach((g, i) =>
      db
        .prepare(
          "INSERT INTO gaps(id,plan_id,topic_id,opened_at,closed_at,origin,misconception,severity,comparison) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          gapIds[i],
          planId,
          topicRef(topicIds, g.topic),
          g.openedAt,
          g.closedAt,
          g.origin,
          g.misconception,
          g.severity,
          g.comparison,
        ),
    );
    gapRows.forEach((g, i) => {
      if (g.mergedInto != null)
        db.prepare("UPDATE gaps SET merged_into=? WHERE id=?").run(ref(g.mergedInto), gapIds[i]);
    });
    attemptRows.forEach((a, i) =>
      db
        .prepare(
          "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES(?,?,?,?,?)",
        )
        .run(attemptIds[i], planId, ref(a.item), a.startedAt, a.submittedAt),
    );
    for (const link of file.gapAnswers ?? [])
      db.prepare(
        "INSERT INTO gap_answers(gap_id,attempt_id,question_id) VALUES(?,?,?)",
      ).run(ref(link.gap), ref(link.attempt), ref(link.question));
    for (const link of file.gapItems ?? [])
      db.prepare("INSERT INTO gap_items(gap_id,item_id) VALUES(?,?)").run(
        ref(link.gap),
        ref(link.item),
      );
    cards.forEach((c, i) => {
      db.prepare(
        "INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,grounding,suspended,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        cardIds[i],
        planId,
        c.topicId,
        c.front,
        c.back,
        c.passageId,
        c.grounding ?? (c.passageId ? "sources" : "general"),
        c.suspended ? 1 : 0,
        now,
      );
      if (c.schedule)
        db.prepare(
          "INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES(?,?,?,?,?)",
        ).run(
          uuidv7(now + sequence++),
          cardIds[i],
          c.schedule.rating,
          JSON.stringify(c.schedule.state),
          c.schedule.at,
        );
    });
    maps.forEach((m, i) =>
      db
        .prepare(
          "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          mapIds[i],
          planId,
          m.topicId,
          JSON.stringify({ version: 1, maps: m.entries }),
          m.entries.some((e) => e.passageIds.length) ? "sources" : "general",
          now,
        ),
    );
    progress.forEach((event) =>
      db
        .prepare(
          "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          uuidv7(now + sequence++),
          event.kind,
          planId,
          event.topicId,
          JSON.stringify(event.payload),
          event.at,
        ),
    );
    return planId;
  })();
}
