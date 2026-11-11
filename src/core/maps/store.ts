import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { isTopicScope, requireScope, type MapScope } from "./scope";
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
  /** What the student asked for when they had this map built. It lives in the map's JSON, so it needs no column. */
  instruction?: string;
};
type Collection = { version: 1; maps: StoredMap[] };
/** The scope's maps and the ID of the row that holds them (null before the first map), in one read. */
function collectionRow(
  db: Database.Database,
  scope: MapScope,
): { rowId: string | null; value: Collection } {
  requireScope(db, scope);
  const row = (
    isTopicScope(scope)
      ? db
          .prepare("SELECT id, graph_json, grounding FROM maps WHERE plan_id = ? AND topic_id = ?")
          .get(scope.planId, scope.topicId)
      : db
          .prepare(
            "SELECT id, graph_json, grounding FROM maps WHERE subject_id = ? AND plan_id IS NULL AND topic_id IS NULL",
          )
          .get(scope.subjectId)
  ) as { id: string; graph_json: string; grounding: string } | undefined;
  if (!row) return { rowId: null, value: { version: 1, maps: [] } };
  return { rowId: row.id, value: parseCollection(row) };
}
function collection(db: Database.Database, scope: MapScope): Collection {
  return collectionRow(db, scope).value;
}
/** The maps one topic's or subject's row holds. Rows saved before collections hold one bare graph. */
export function parseCollection(row: {
  id: string;
  graph_json: string;
  grounding: string | null;
}): Collection {
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
export function listMaps(db: Database.Database, scope: MapScope): MapSummary[] {
  return collection(db, scope).maps.map(
    ({ id, title, passageIds, provider, model, grounding, instruction }) => ({
      id,
      title,
      passageCount: passageIds.length,
      grounding: grounding ?? (passageIds.length ? "sources" : "general"),
      provider,
      model,
      instruction,
    }),
  );
}
export function storeMap(
  db: Database.Database,
  scope: MapScope,
  map: StoredMap,
): void {
  db.transaction(() => {
    const { rowId, value } = collectionRow(db, scope);
    const index = value.maps.findIndex((item) => item.id === map.id);
    if (index < 0) value.maps.push(map);
    else value.maps[index] = map;
    save(db, scope, rowId, value, map.grounding, map.prompt);
  })();
}
/** Writes the scope's row. A topic row takes its exam's subject from the database's trigger. */
function save(
  db: Database.Database,
  scope: MapScope,
  rowId: string | null,
  value: Collection,
  grounding?: string,
  prompt?: { template: string; version: string },
): void {
  if (rowId)
    db.prepare(
      "UPDATE maps SET graph_json = ?, grounding = COALESCE(?, grounding), prompt_template = COALESCE(?, prompt_template), prompt_version = COALESCE(?, prompt_version) WHERE id = ?",
    ).run(
      JSON.stringify(value),
      grounding ?? null,
      prompt?.template ?? null,
      prompt?.version ?? null,
      rowId,
    );
  else
    db.prepare(
      "INSERT INTO maps (id, subject_id, plan_id, topic_id, graph_json, grounding, prompt_template, prompt_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      uuidv7(),
      isTopicScope(scope) ? null : scope.subjectId,
      isTopicScope(scope) ? scope.planId : null,
      isTopicScope(scope) ? scope.topicId : null,
      JSON.stringify(value),
      grounding ?? "sources",
      prompt?.template ?? null,
      prompt?.version ?? null,
      Date.now(),
    );
}
export function readStoredMap(
  db: Database.Database,
  scope: MapScope,
  mapId?: string,
): StoredMap | undefined {
  const maps = collection(db, scope).maps;
  const selected = mapId ? maps.find((map) => map.id === mapId) : maps[0];
  if (mapId && !selected) throw new Error("map-missing");
  return selected;
}
export function openMap(
  db: Database.Database,
  scope: MapScope,
  now = Date.now(),
  mapId?: string,
): ConceptGraph {
  const existing = readStoredMap(db, scope, mapId);
  if (existing) return existing.graph;
  // A subject has no offline outline: its map page offers to build the map instead.
  if (!isTopicScope(scope)) throw new Error("map-missing");
  const { planId, topicId } = scope;
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
  storeMap(db, scope, {
    id: uuidv7(now),
    title: topic.title,
    passageIds: passages.map((row) => row.id),
    graph,
    grounding: passages.length ? "sources" : "general",
  });
  return graph;
}
/**
 * Changes one map and saves it laid out, reading the scope's row once. A topic with no map yet gets the offline outline
 * `openMap` makes first. `change` may throw, and then nothing is saved.
 */
function editMapGraph(
  db: Database.Database,
  scope: MapScope,
  mapId: string | undefined,
  change: (graph: ConceptGraph) => ConceptGraph,
): ConceptGraph {
  return db.transaction(() => {
    let { rowId, value } = collectionRow(db, scope);
    let index = mapId ? value.maps.findIndex((map) => map.id === mapId) : 0;
    if (index < 0) throw new Error("map-missing");
    if (!value.maps[index]) {
      openMap(db, scope);
      ({ rowId, value } = collectionRow(db, scope));
      index = 0;
    }
    const stored = value.maps[index]!;
    const next = layoutGraph(change(stored.graph));
    value.maps[index] = { ...stored, graph: next };
    save(db, scope, rowId, value, stored.grounding, stored.prompt);
    return next;
  })();
}
function snapshot(graph: ConceptGraph): NonNullable<ConceptGraph["undo"]> {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    layout: graph.layout,
  };
}
export function moveMapNode(
  db: Database.Database,
  scope: MapScope,
  nodeId: string,
  x: number,
  y: number,
  mapId?: string,
): ConceptGraph {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("map-position");
  return editMapGraph(db, scope, mapId, (graph) => {
    if (!graph.nodes.some((node) => node.id === nodeId))
      throw new Error("map-missing");
    return {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === nodeId ? { ...node, x, y, pinned: true } : node,
      ),
      undo: snapshot(graph),
      redo: null,
    };
  });
}
export function setMapLayout(
  db: Database.Database,
  scope: MapScope,
  layout: ConceptGraph["layout"],
  mapId?: string,
): ConceptGraph {
  return editMapGraph(db, scope, mapId, (graph) => ({
    ...graph,
    layout,
    undo: snapshot(graph),
    redo: null,
  }));
}
export function patchMap(
  db: Database.Database,
  scope: MapScope,
  ops: MapOp[],
  mapId?: string,
): ConceptGraph {
  return editMapGraph(db, scope, mapId, (graph) => applyOps(graph, ops));
}
export function undoMap(
  db: Database.Database,
  scope: MapScope,
  mapId?: string,
): ConceptGraph {
  return editMapGraph(db, scope, mapId, undoGraph);
}

export function redoMap(
  db: Database.Database,
  scope: MapScope,
  mapId?: string,
): ConceptGraph {
  return editMapGraph(db, scope, mapId, redoGraph);
}
