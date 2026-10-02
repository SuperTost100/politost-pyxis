import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { uuidv7 } from "../../shared/ids";
import { planFileSchema, type PlanFile } from "../../shared/plan-file";
import { putBlob, readBlob } from "../blobs";
import { validateGraph, type ConceptGraph } from "../maps/graph";

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
      `SELECT id, title, position, tree_json FROM topics WHERE plan_id = ? ORDER BY position`,
    )
    .all(planId) as Array<{
    id: string;
    title: string;
    position: number;
    tree_json: string | null;
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
  const content = exportContent(db, planId, index);
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
  return {
    version: 2,
    id: planId,
    createdAt: Date.now(),
    ...content,
    title: plan.title,
    topics: topics.map((topic) => ({
      id: topic.id,
      title: topic.title,
      position: topic.position,
      ...(topic.tree_json ? { tree: JSON.parse(topic.tree_json) } : {}),
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
      plan.style === "read" ||
      plan.style === "practice" ||
      plan.style === "decide"
        ? plan.style
        : "decide",
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
        JSON.stringify(
          importedPayload(event.kind, event.payload, nodeIds) ?? {},
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
) {
  const passages = db
    .prepare(
      `SELECT DISTINCT p.*,COALESCE(s.blob_sha,json_extract(sd.tree_json, '$.sourceSha')) AS blob_sha FROM passages p LEFT JOIN sources s ON s.id=p.source_id LEFT JOIN source_documents sd ON sd.id=p.document_id WHERE p.id IN (SELECT tp.passage_id FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=? UNION SELECT ip.passage_id FROM item_passages ip JOIN items i ON i.id=ip.item_id WHERE i.plan_id=? UNION SELECT passage_id FROM cards WHERE plan_id=? AND removed=0 AND passage_id IS NOT NULL) ORDER BY p.id`,
    )
    .all(planId, planId, planId) as {
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
      "SELECT body_json AS content FROM items WHERE plan_id=? UNION ALL SELECT graph_json AS content FROM maps WHERE plan_id=?",
    )
    .all(planId, planId) as { content: string }[])
    citations(JSON.parse(row.content));
  const citedExerciseIds = [...citedIds];
  const exercisePassages = db
    .prepare(
      `SELECT e.passage_id AS id FROM exercises e LEFT JOIN smartbooks sb ON sb.id=e.smartbook_id WHERE e.passage_id IS NOT NULL AND (sb.source_id IN (SELECT source_id FROM plan_sources WHERE plan_id=?) OR e.id IN (${citedExerciseIds.map(() => "?").join(",") || "NULL"}))`,
    )
    .all(planId, ...citedExerciseIds) as { id: string }[];
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
      .prepare("SELECT * FROM items WHERE plan_id=? ORDER BY created_at,id")
      .all(planId) as {
      id: string;
      topic_id: string | null;
      kind: "lesson" | "intro" | "diagnostic" | "quiz" | "simulation";
      body_json: string;
      grounding: "sources" | "mixed" | "general" | null;
      engine_provider: string | null;
      model_id: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    topic: row.topic_id == null ? null : (topicIndex.get(row.topic_id) ?? null),
    kind: row.kind,
    body: portableQuestionIds(row.id, cleanContent(JSON.parse(row.body_json))),
    passageIds: (
      db
        .prepare(
          "SELECT passage_id AS id FROM item_passages WHERE item_id=? ORDER BY passage_id",
        )
        .all(row.id) as { id: string }[]
    ).map((p) => p.id),
    grounding: row.grounding,
    provider: row.engine_provider,
    model: row.model_id,
  }));
  const exercises = (
    db
      .prepare(
        `SELECT e.*,sb.source_id FROM exercises e LEFT JOIN smartbooks sb ON sb.id=e.smartbook_id WHERE sb.source_id IN (SELECT source_id FROM plan_sources WHERE plan_id=?) OR e.passage_id IN (SELECT tp.passage_id FROM topic_passages tp JOIN topics t ON t.id=tp.topic_id WHERE t.plan_id=?) OR e.id IN (${[...citedIds].map(() => "?").join(",") || "NULL"}) ORDER BY e.created_at,e.id`,
      )
      .all(planId, planId, ...citedIds) as {
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
  function remap(value: unknown, key = ""): unknown {
    if (Array.isArray(value)) return value.map((item) => remap(item, key));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, item]) => [k, remap(item, k)]),
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
      if (
        [
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
        ].includes(key)
      )
        return ref(value);
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
    const locals = new Map<string, string>();
    for (const node of [...graph.nodes, ...(graph.undo?.nodes ?? [])])
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
    };
  };
  // Validate every reference and prepare content before writing database rows or blobs.
  const topics = file.topics.map((t) => ({
    ...t,
    tree: t.tree ? remap(t.tree) : null,
    passageIds: t.passageIds?.map((id) => checkedRef(id, passageKeys)!),
  }));
  const documents = (file.documents ?? []).map((d) => ({
    ...d,
    sourceId: checkedRef(d.sourceId, sourceKeys)!,
    tree: remap(d.tree),
  }));
  const passages = (file.passages ?? []).map((p) => {
    if (createHash("sha256").update(p.text).digest("hex") !== p.textSha)
      throw new Error("plan-file");
    const source = (file.sources ?? []).find((s) => s.id === p.sourceId);
    if (p.sourceSha && source?.sha !== p.sourceSha)
      throw new Error("plan-file");
    const document = (file.documents ?? []).find((d) => d.id === p.documentId);
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
  const exercises = (file.exercises ?? []).map((e) => ({
    ...e,
    sourceId: checkedRef(e.sourceId, sourceKeys),
    passageId: checkedRef(e.passageId, passageKeys),
    locator: remap(e.locator),
  }));
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
  const progress = (file.progress ?? []).map((e) => ({
    ...e,
    topicId: topicRef(topicIds, e.topic),
    payload: remap(importedPayload(e.kind, e.payload, nodeIds)),
  }));
  return db.transaction(() => {
    db.prepare(
      "INSERT INTO plans(id,title,status,content_language,exam_at,target,style,created_at,updated_at) VALUES(?,?,'ready',?,?,?,?,?,?)",
    ).run(
      planId,
      file.title,
      file.language ?? null,
      file.examAt ?? null,
      file.target ?? 0.75,
      file.style ?? "decide",
      now,
      now,
    );
    topics.forEach((t, i) => {
      db.prepare(
        "INSERT INTO topics(id,plan_id,title,position,tree_json,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        topicIds[i],
        planId,
        t.title,
        t.position,
        t.tree ? JSON.stringify(t.tree) : null,
        now,
      );
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
      const hasExercise = exercises.some((e) => e.sourceId === sourceIds[i]);
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
                  documents.find((d) => d.sourceId === sourceIds[i])?.tree as
                    { chapters?: unknown[] } | undefined
                )?.chapters ?? [])
              : [],
          }),
          now,
        );
    });
    documents.forEach((d, i) =>
      db
        .prepare(
          "INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          documentIds[i],
          d.sourceId,
          d.version,
          JSON.stringify({
            ...(d.tree as object),
            sourceSha:
              (file.sources ?? []).find(
                (s) => s.id === (file.documents ?? [])[i]!.sourceId,
              )?.sha ?? null,
            kind: embedded.has(
              (file.sources ?? []).findIndex(
                (s) => s.id === (file.documents ?? [])[i]!.sourceId,
              ),
            )
              ? (file.sources ?? []).find(
                  (s) => s.id === (file.documents ?? [])[i]!.sourceId,
                )?.kind
              : "excerpt",
          }),
          now,
        ),
    );
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
