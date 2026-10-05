import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import type { BuildTopic } from "./create";
import { finishSourceRebuild } from "./views";

// PLAN-13: the new source-built tree is matched to the active topics, the user reviews the diff,
// and apply writes exactly the stored match. Nothing here recomputes after the review.

/** Passage sets overlap above this Jaccard index. */
export const JACCARD_MIN = 0.3;
/** ponytail: cosine of e5 title vectors is compressed into 0.7 to 1, so 0.9 is a conservative "same title". Tune against real plans. */
export const TITLE_SIMILARITY_MIN = 0.9;

export type RebuildMatch = {
  oldId: string;
  newIndex: number;
  reason: "passages" | "title";
  score: number;
};

/** Stored with the job, so apply uses the reviewed result. */
export type RebuildPlan = {
  tree: BuildTopic[];
  matches: RebuildMatch[];
  /** Active topic ids no new topic matched. */
  archived: string[];
  /** Active topic and source ids at review time; apply refuses when they changed. */
  fingerprint: string;
};

export type Embed = (text: string) => Promise<Float32Array | null>;

/**
 * What a passage is, apart from its row id. A re-extract or a replaced file gives every passage a new id, so a topic's
 * old ids and the new tree's ids never meet. The same text, or the same place in the same original file (page, slide,
 * chapter, paragraph or heading), is what stays.
 */
export type PassageIdentity = { text: string[]; locator: string[] };

const LOCATOR_KEYS = [
  "chapter",
  "heading",
  "page",
  "paragraph",
  "slide",
] as const;
const IDENTITY_BATCH = 400;
// The original file's hash is `blobSha` on a document extracted here and `sourceSha` on one a plan file brought in.
// Import sets `sourceSha` only from the file's own source list, after checking an embedded file's bytes against it.

export function passageIdentity(
  db: Database.Database,
  ids: string[],
): PassageIdentity {
  const text = new Set<string>();
  const locator = new Set<string>();
  for (let from = 0; from < ids.length; from += IDENTITY_BATCH) {
    const batch = ids.slice(from, from + IDENTITY_BATCH);
    const rows = db
      .prepare(
        `SELECT p.source_id AS sourceId, p.text, p.locator_json AS locatorJson,
                COALESCE(json_extract(d.tree_json, '$.blobSha'), json_extract(d.tree_json, '$.sourceSha')) AS blobSha
         FROM passages p LEFT JOIN source_documents d ON d.id = p.document_id
         WHERE p.id IN (${batch.map(() => "?").join(", ")})`,
      )
      .all(...batch) as Array<{
      sourceId: string | null;
      text: string;
      locatorJson: string | null;
      blobSha: string | null;
    }>;
    for (const row of rows) {
      const words = row.text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      text.add(
        createHash("sha1")
          .update(`${row.sourceId ?? ""}|${words}`)
          .digest("base64"),
      );
      const parsed = row.locatorJson
        ? (JSON.parse(row.locatorJson) as Record<string, unknown>)
        : {};
      const place = LOCATOR_KEYS.flatMap((key) =>
        parsed[key] == null ? [] : [[key, parsed[key]]],
      );
      // A passage with no place (plain text without headings) has none to match on; it must not match every other one.
      if (place.length > 0 && row.blobSha)
        locator.add(`${row.sourceId ?? ""}|${row.blobSha}|${JSON.stringify(place)}`);
    }
  }
  return { text: [...text], locator: [...locator] };
}

type ActiveTopic = {
  id: string;
  title: string;
  position: number;
  passageIds: string[];
};

function activeTopics(db: Database.Database, planId: string): ActiveTopic[] {
  const topics = db
    .prepare(
      "SELECT id, title, position FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position, id",
    )
    .all(planId) as Array<Omit<ActiveTopic, "passageIds">>;
  const link = db.prepare(
    "SELECT passage_id AS id FROM topic_passages WHERE topic_id = ? ORDER BY passage_id",
  );
  return topics.map((topic) => ({
    ...topic,
    passageIds: (link.all(topic.id) as Array<{ id: string }>).map((r) => r.id),
  }));
}

function fingerprintOf(db: Database.Database, planId: string): string {
  return JSON.stringify({
    topics: activeTopics(db, planId),
    sources: db
      .prepare(
        `SELECT s.id, s.title, s.blob_sha, s.status,
            (SELECT MAX(version) FROM source_documents WHERE source_id = s.id) AS version
           FROM plan_sources ps JOIN sources s ON s.id = ps.source_id
           WHERE ps.plan_id = ? ORDER BY s.id`,
      )
      .all(planId),
  });
}

const normalized = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const left = new Set(a);
  const common = new Set(b.filter((id) => left.has(id))).size;
  return common / (left.size + new Set(b).size - common);
}

type Matchable = { passageIds: string[]; identity?: PassageIdentity };

/** The best Jaccard over row ids, then over text and place when both sides have an identity. */
function overlapOf(a: Matchable, b: Matchable): number {
  const byId = jaccard(a.passageIds, b.passageIds);
  if (!a.identity || !b.identity) return byId;
  return Math.max(
    byId,
    jaccard(a.identity.text, b.identity.text),
    jaccard(a.identity.locator, b.identity.locator),
  );
}

/** Pure matching: greedy best pair first, each topic used once. */
export function matchTopics(
  old: Array<{ id: string; title: string } & Matchable>,
  next: Array<{ title: string } & Matchable>,
  titleSimilarity: (oldIndex: number, newIndex: number) => number,
): { matches: RebuildMatch[]; archived: string[] } {
  const pairs: Array<RebuildMatch & { oldIndex: number }> = [];
  old.forEach((topic, oldIndex) =>
    next.forEach((fresh, newIndex) => {
      const overlap = overlapOf(topic, fresh);
      const similarity = titleSimilarity(oldIndex, newIndex);
      const byPassages = overlap > JACCARD_MIN;
      const byTitle = similarity >= TITLE_SIMILARITY_MIN;
      if (!byPassages && !byTitle) return;
      pairs.push({
        oldId: topic.id,
        oldIndex,
        newIndex,
        reason: byPassages ? "passages" : "title",
        score: Math.max(byPassages ? overlap : 0, byTitle ? similarity : 0),
      });
    }),
  );
  pairs.sort(
    (a, b) =>
      b.score - a.score || a.oldIndex - b.oldIndex || a.newIndex - b.newIndex,
  );
  const usedOld = new Set<string>();
  const usedNew = new Set<number>();
  const matches: RebuildMatch[] = [];
  for (const { oldIndex: _oldIndex, ...pair } of pairs) {
    if (usedOld.has(pair.oldId) || usedNew.has(pair.newIndex)) continue;
    usedOld.add(pair.oldId);
    usedNew.add(pair.newIndex);
    matches.push(pair);
  }
  matches.sort((a, b) => a.newIndex - b.newIndex);
  return {
    matches,
    archived: old.filter((topic) => !usedOld.has(topic.id)).map((t) => t.id),
  };
}

export async function computeRebuild(
  db: Database.Database,
  planId: string,
  tree: BuildTopic[],
  embed?: Embed,
  signal?: AbortSignal,
): Promise<RebuildPlan> {
  const old = activeTopics(db, planId);
  const vector = async (title: string) => {
    signal?.throwIfAborted();
    return embed ? embed(`query: ${title}`) : null;
  };
  const oldVectors = await Promise.all(old.map((t) => vector(t.title)));
  const newVectors = await Promise.all(tree.map((t) => vector(t.title)));
  // The old topics cite passages of the version they were built from, the new tree those of the latest, so ids alone miss.
  const { matches, archived } = matchTopics(
    old.map((topic) => ({
      ...topic,
      identity: passageIdentity(db, topic.passageIds),
    })),
    tree.map((topic) => ({
      ...topic,
      identity: passageIdentity(db, topic.passageIds),
    })),
    (i, j) => {
      if (normalized(old[i]!.title) === normalized(tree[j]!.title)) return 1;
      const a = oldVectors[i];
      const b = newVectors[j];
      return a && b ? cosine(a, b) : 0;
    },
  );
  return { tree, matches, archived, fingerprint: fingerprintOf(db, planId) };
}

/** The three lists the user reviews. Everything comes from the stored plan plus current titles. */
export function reviewRebuild(
  db: Database.Database,
  planId: string,
  rebuild: RebuildPlan,
) {
  const old = new Map(activeTopics(db, planId).map((t) => [t.id, t]));
  const withHistory = (topicId: string) =>
    Boolean(
      db
        .prepare(
          `SELECT EXISTS(SELECT 1 FROM learning_events WHERE topic_id = ?)
               OR EXISTS(SELECT 1 FROM cards WHERE topic_id = ? AND removed = 0)
               OR EXISTS(SELECT 1 FROM gaps WHERE topic_id = ?) AS found`,
        )
        .pluck()
        .get(topicId, topicId, topicId),
    );
  const matched = new Set(rebuild.matches.map((m) => m.newIndex));
  return {
    stale: rebuild.fingerprint !== fingerprintOf(db, planId),
    kept: rebuild.matches.map((match) => ({
      id: match.oldId,
      title: old.get(match.oldId)?.title ?? "",
      // The topic keeps its own title; the new tree's title is shown so a match by place or text is visible.
      newTitle: rebuild.tree[match.newIndex]?.title ?? "",
      reason: match.reason,
      score: Math.round(match.score * 100) / 100,
    })),
    added: rebuild.tree.flatMap((topic, index) =>
      matched.has(index)
        ? []
        : [{ title: topic.title, passages: topic.passageIds.length }],
    ),
    archived: rebuild.archived.map((id) => ({
      id,
      title: old.get(id)?.title ?? "",
      progress: withHistory(id),
    })),
  };
}

const stagesFor = (style: string) =>
  style === "practice"
    ? (["practice", "learn", "cards", "gaps"] as const)
    : (["learn", "practice", "cards", "gaps"] as const);

export function applyRebuild(
  db: Database.Database,
  planId: string,
  rebuild: RebuildPlan,
  now = Date.now(),
): { kept: number; added: number; archived: number } {
  return db.transaction(() => {
    const plan = db
      .prepare("SELECT status, style FROM plans WHERE id = ?")
      .get(planId) as { status: string; style: string } | undefined;
    if (!plan) throw new Error("plan-missing");
    if (plan.status === "building") throw new Error("plan-missing-or-building");
    if (rebuild.fingerprint !== fingerprintOf(db, planId))
      throw new Error("rebuild-stale");

    const matchFor = new Map(rebuild.matches.map((m) => [m.newIndex, m.oldId]));
    const order: string[] = [];
    const created: string[] = [];
    const link = db.prepare(
      "INSERT OR IGNORE INTO topic_passages (topic_id, passage_id) VALUES (?, ?)",
    );
    rebuild.tree.forEach((topic, index) => {
      const tree = JSON.stringify({
        summary: topic.summary,
        subtopics: topic.subtopics,
      });
      const grounding = topic.passageIds.length ? "sources" : "general";
      const oldId = matchFor.get(index);
      if (oldId) {
        // The matched topic keeps its id and title; events, cards and gaps stay attached.
        db.prepare(
          `UPDATE topics SET position = ?, tree_json = ?, grounding = ?,
             engine_provider = COALESCE(?, engine_provider), model_id = COALESCE(?, model_id)
           WHERE id = ?`,
        ).run(
          index,
          tree,
          grounding,
          topic.provider ?? null,
          topic.model ?? null,
          oldId,
        );
        db.prepare("DELETE FROM topic_passages WHERE topic_id = ?").run(oldId);
        for (const passageId of topic.passageIds) link.run(oldId, passageId);
        order.push(oldId);
        return;
      }
      const id = uuidv7(now + index + 1);
      db.prepare(
        `INSERT INTO topics (id, plan_id, title, position, tree_json, grounding, engine_provider, model_id, model_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        planId,
        topic.title,
        index,
        tree,
        grounding,
        topic.provider ?? null,
        topic.model ?? null,
        topic.model ? "reported" : null,
        now,
      );
      for (const passageId of topic.passageIds) link.run(id, passageId);
      order.push(id);
      created.push(id);
    });
    for (const id of rebuild.archived)
      db.prepare(
        "UPDATE topics SET archived_at = ? WHERE id = ? AND plan_id = ?",
      ).run(now, id, planId);

    const insertNode = db.prepare(
      `INSERT INTO path_nodes (id, plan_id, topic_id, kind, position, title, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    );
    created.forEach((topicId, i) => {
      const title = rebuild.tree[order.indexOf(topicId)]!.title;
      stagesFor(plan.style).forEach((stage, j) =>
        insertNode.run(
          uuidv7(now + 1000 + i * 4 + j),
          planId,
          topicId,
          stage,
          title,
          now,
        ),
      );
    });
    // One pass restores a single order: opening stages, topics in the new order, closing stages, then archived history.
    const nodes = db
      .prepare(
        "SELECT id, topic_id, kind FROM path_nodes WHERE plan_id = ? ORDER BY position, rowid",
      )
      .all(planId) as Array<{
      id: string;
      topic_id: string | null;
      kind: string;
    }>;
    const rank = new Map(order.map((id, i) => [id, i]));
    const slot = (node: (typeof nodes)[number]) =>
      node.topic_id == null
        ? ["intro", "diagnostic"].includes(node.kind)
          ? 0
          : 2 + order.length
        : rank.has(node.topic_id)
          ? 1 + rank.get(node.topic_id)!
          : 3 + order.length;
    nodes
      .map((node, i) => ({ node, i }))
      .sort((a, b) => slot(a.node) - slot(b.node) || a.i - b.i)
      .forEach(({ node }, position) =>
        db
          .prepare("UPDATE path_nodes SET position = ? WHERE id = ?")
          .run(position, node.id),
      );
    db.prepare(
      "UPDATE plans SET status = 'ready', updated_at = ? WHERE id = ?",
    ).run(now, planId);
    finishSourceRebuild(
      db,
      planId,
      (
        db
          .prepare("SELECT source_id AS id FROM plan_sources WHERE plan_id = ?")
          .all(planId) as Array<{ id: string }>
      ).map((row) => row.id),
    );
    return {
      kept: rebuild.matches.length,
      added: created.length,
      archived: rebuild.archived.length,
    };
  })();
}
