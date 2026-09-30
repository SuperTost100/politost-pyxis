import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  applyOps,
  layoutGraph,
  undoGraph,
  type ConceptGraph,
  type MapOp,
} from "./graph";

export function openTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  now = Date.now(),
): ConceptGraph {
  const existing = db
    .prepare(`SELECT graph_json FROM maps WHERE plan_id = ? AND topic_id = ?`)
    .get(planId, topicId) as { graph_json: string } | undefined;
  if (existing) return JSON.parse(existing.graph_json) as ConceptGraph;
  const topic = db.prepare(`SELECT title FROM topics WHERE id = ? AND plan_id = ?`).get(
    topicId,
    planId,
  ) as { title: string } | undefined;
  if (!topic) throw new Error("topic-missing");
  const passages = db
    .prepare(
      `SELECT p.id, p.text, p.section_path
       FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ?
       ORDER BY p.created_at
       LIMIT 24`,
    )
    .all(topicId) as Array<{ id: string; text: string; section_path: string | null }>;
  const graph = layoutGraph({
    layout: "tree",
    undo: null,
    nodes: [
      { id: "root", label: topic.title, parent: null, x: 0, y: 0, pinned: false },
      ...passages.map((row) => {
        const text = row.text.replace(/\s+/g, " ").trim().slice(0, 36);
        const section = row.section_path?.trim();
        return {
          id: row.id,
          label: section && text ? `${section} · ${text}` : section || text,
          parent: "root" as string | null,
          x: 0,
          y: 0,
          pinned: false,
        };
      }),
    ],
    edges: [],
  });
  graph.edges = graph.nodes
    .filter((node) => node.parent)
    .map((node) => ({ from: node.parent as string, to: node.id }));
  save(db, planId, topicId, layoutGraph(graph), now);
  return layoutGraph(graph);
}

export function saveTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  graph: ConceptGraph,
): ConceptGraph {
  const next = layoutGraph(graph);
  save(db, planId, topicId, next);
  return next;
}

export function moveTopicNode(
  db: Database.Database,
  planId: string,
  topicId: string,
  nodeId: string,
  x: number,
  y: number,
): ConceptGraph {
  const graph = openTopicMap(db, planId, topicId);
  const nodes = graph.nodes.map((node) =>
    node.id === nodeId ? { ...node, x, y, pinned: true } : node,
  );
  if (!nodes.some((node) => node.id === nodeId)) throw new Error("map-missing");
  return saveTopicMap(db, planId, topicId, { ...graph, nodes });
}

export function setTopicLayout(
  db: Database.Database,
  planId: string,
  topicId: string,
  layout: ConceptGraph["layout"],
): ConceptGraph {
  const graph = openTopicMap(db, planId, topicId);
  return saveTopicMap(db, planId, topicId, { ...graph, layout });
}

export function patchTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  ops: MapOp[],
): ConceptGraph {
  const next = applyOps(openTopicMap(db, planId, topicId), ops);
  save(db, planId, topicId, next);
  return next;
}

export function undoTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
): ConceptGraph {
  const next = undoGraph(openTopicMap(db, planId, topicId));
  save(db, planId, topicId, next);
  return next;
}

function save(
  db: Database.Database,
  planId: string,
  topicId: string,
  graph: ConceptGraph,
  now = Date.now(),
): void {
  const row = db
    .prepare(`SELECT id FROM maps WHERE plan_id = ? AND topic_id = ?`)
    .get(planId, topicId) as { id: string } | undefined;
  if (row) {
    db.prepare(`UPDATE maps SET graph_json = ? WHERE id = ?`).run(JSON.stringify(graph), row.id);
    return;
  }
  db.prepare(
    `INSERT INTO maps (id, plan_id, topic_id, graph_json, grounding, created_at)
     VALUES (?, ?, ?, ?, 'sources', ?)`,
  ).run(uuidv7(now), planId, topicId, JSON.stringify(graph), now);
}
