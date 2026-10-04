import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { requireTopic } from "../study/openLesson";
import {
  applyOps,
  layoutGraph,
  undoGraph,
  redoGraph,
  type ConceptGraph,
  type MapOp,
} from "./graph";
import type { MapSummary } from "../../shared/concept-map";

export type StoredMap = {
  id: string;
  title: string;
  passageIds: string[];
  graph: ConceptGraph;
  provider?: string;
  model?: string;
  /** Template ID and version that generated the map. */
  prompt?: { template: string; version: string };
  grounding?: "sources" | "general";
};
type Collection = { version: 1; maps: StoredMap[] };
function collection(
  db: Database.Database,
  planId: string,
  topicId: string,
): Collection {
  requireTopic(db, planId, topicId);
  const row = db
    .prepare(
      "SELECT id, graph_json, grounding FROM maps WHERE plan_id = ? AND topic_id = ?",
    )
    .get(planId, topicId) as
    { id: string; graph_json: string; grounding: string } | undefined;
  if (!row) return { version: 1, maps: [] };
  const parsed = JSON.parse(row.graph_json) as Collection | ConceptGraph;
  if ("version" in parsed && parsed.version === 1) return parsed;
  const graph = parsed as ConceptGraph;
  return {
    version: 1,
    maps: [
      {
        id: row.id,
        title: graph.nodes.find((node) => node.parent === null)?.label ?? "Map",
        grounding: row.grounding === "sources" ? "sources" : "general",
        passageIds: [
          ...new Set(graph.nodes.flatMap((node) => node.sources ?? [])),
        ],
        graph,
      },
    ],
  };
}
export function listTopicMaps(
  db: Database.Database,
  planId: string,
  topicId: string,
): MapSummary[] {
  return collection(db, planId, topicId).maps.map(
    ({ id, title, passageIds, provider, model, grounding }) => ({
      id,
      title,
      passageCount: passageIds.length,
      grounding: grounding ?? (passageIds.length ? "sources" : "general"),
      provider,
      model,
    }),
  );
}
export function storeMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  map: StoredMap,
): void {
  db.transaction(() => {
    const value = collection(db, planId, topicId);
    const index = value.maps.findIndex((item) => item.id === map.id);
    if (index < 0) value.maps.push(map);
    else value.maps[index] = map;
    save(db, planId, topicId, value, map.grounding, map.prompt);
  })();
}
function save(
  db: Database.Database,
  planId: string,
  topicId: string,
  value: Collection,
  grounding?: string,
  prompt?: { template: string; version: string },
): void {
  const row = db
    .prepare("SELECT id FROM maps WHERE plan_id = ? AND topic_id = ?")
    .get(planId, topicId) as { id: string } | undefined;
  if (row)
    db.prepare(
      "UPDATE maps SET graph_json = ?, grounding = COALESCE(?, grounding), prompt_template = COALESCE(?, prompt_template), prompt_version = COALESCE(?, prompt_version) WHERE id = ?",
    ).run(
      JSON.stringify(value),
      grounding ?? null,
      prompt?.template ?? null,
      prompt?.version ?? null,
      row.id,
    );
  else
    db.prepare(
      "INSERT INTO maps (id, plan_id, topic_id, graph_json, grounding, prompt_template, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      uuidv7(),
      planId,
      topicId,
      JSON.stringify(value),
      grounding ?? "sources",
      prompt?.template ?? null,
      prompt?.version ?? null,
      Date.now(),
    );
}
export function readStoredMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  mapId?: string,
): StoredMap | undefined {
  const maps = collection(db, planId, topicId).maps;
  const selected = mapId ? maps.find((map) => map.id === mapId) : maps[0];
  if (mapId && !selected) throw new Error("map-missing");
  return selected;
}
export function openTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  now = Date.now(),
  mapId?: string,
): ConceptGraph {
  const existing = readStoredMap(db, planId, topicId, mapId);
  if (existing) return existing.graph;
  // Legacy callers get an offline outline. The map UI uses explicit model generation.
  const topic = db
    .prepare("SELECT title FROM topics WHERE id = ? AND plan_id = ?")
    .get(topicId, planId) as { title: string };
  const passages = db
    .prepare(
      "SELECT p.id, p.text, p.section_path FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ? ORDER BY p.created_at, p.id LIMIT 24",
    )
    .all(topicId) as Array<{
    id: string;
    text: string;
    section_path: string | null;
  }>;
  const graph = layoutGraph({
    layout: "tree",
    undo: null,
    nodes: [
      {
        id: "root",
        label: topic.title,
        parent: null,
        x: 0,
        y: 0,
        pinned: false,
      },
      ...passages.map((row) => ({
        id: row.id,
        label:
          (
            row.section_path ?? row.text.replace(/\s+/g, " ").slice(0, 80)
          ).trim() || "Material",
        parent: "root",
        x: 0,
        y: 0,
        pinned: false,
        sources: [row.id],
      })),
    ],
    edges: passages.map((row) => ({ from: "root", to: row.id })),
  });
  storeMap(db, planId, topicId, {
    id: uuidv7(now),
    title: topic.title,
    passageIds: passages.map((row) => row.id),
    graph,
    grounding: passages.length ? "sources" : "general",
  });
  return graph;
}
export function saveTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  graph: ConceptGraph,
  mapId?: string,
): ConceptGraph {
  const stored = readStoredMap(db, planId, topicId, mapId);
  if (!stored) throw new Error("map-missing");
  const next = layoutGraph(graph);
  storeMap(db, planId, topicId, { ...stored, graph: next });
  return next;
}
function snapshot(graph: ConceptGraph): NonNullable<ConceptGraph["undo"]> {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    layout: graph.layout,
  };
}
export function moveTopicNode(
  db: Database.Database,
  planId: string,
  topicId: string,
  nodeId: string,
  x: number,
  y: number,
  mapId?: string,
): ConceptGraph {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("map-position");
  const graph = openTopicMap(db, planId, topicId, Date.now(), mapId);
  if (!graph.nodes.some((node) => node.id === nodeId))
    throw new Error("map-missing");
  return saveTopicMap(
    db,
    planId,
    topicId,
    {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, x, y, pinned: true } : node,
      ),
      undo: snapshot(graph),
      redo: null,
    },
    mapId,
  );
}
export function setTopicLayout(
  db: Database.Database,
  planId: string,
  topicId: string,
  layout: ConceptGraph["layout"],
  mapId?: string,
): ConceptGraph {
  const graph = openTopicMap(db, planId, topicId, Date.now(), mapId);
  return saveTopicMap(
    db,
    planId,
    topicId,
    { ...graph, layout, undo: snapshot(graph), redo: null },
    mapId,
  );
}
export function patchTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  ops: MapOp[],
  mapId?: string,
): ConceptGraph {
  return saveTopicMap(
    db,
    planId,
    topicId,
    applyOps(openTopicMap(db, planId, topicId, Date.now(), mapId), ops),
    mapId,
  );
}
export function undoTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  mapId?: string,
): ConceptGraph {
  return saveTopicMap(
    db,
    planId,
    topicId,
    undoGraph(openTopicMap(db, planId, topicId, Date.now(), mapId)),
    mapId,
  );
}

export function redoTopicMap(
  db: Database.Database,
  planId: string,
  topicId: string,
  mapId?: string,
): ConceptGraph {
  return saveTopicMap(
    db,
    planId,
    topicId,
    redoGraph(openTopicMap(db, planId, topicId, Date.now(), mapId)),
    mapId,
  );
}
