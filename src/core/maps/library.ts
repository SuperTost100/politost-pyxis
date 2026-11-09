import type Database from "better-sqlite3";
import { MAP_SHAPE, type MapEntry } from "../../shared/concept-map";
import type { ConceptGraph } from "./graph";
import { foldText } from "../study/cardBrowser";
import { parseCollection } from "./store";

type Row = {
  id: string;
  graph_json: string;
  grounding: string | null;
  plan_id: string | null;
  plan_title: string | null;
  topic_id: string | null;
  topic_title: string | null;
  subject_id: string | null;
  subject_name: string | null;
};

/**
 * Every map for the Maps section, by subject in the subjects' order. Within a subject the maps of the whole subject come
 * first, then each exam's in exam and topic order, then the order a row holds its maps in. Maps of an archived or
 * deleted topic stay out, as do those of a deleted subject that no exam holds. Every word of the search has to appear in
 * the map's title or labels, or in its exam, topic or subject name, ignoring case and accents.
 */
export function listAllMaps(db: Database.Database, query = ""): MapEntry[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  const rows = db
    .prepare(
      `SELECT m.id, m.graph_json, m.grounding, m.plan_id, p.title AS plan_title,
        m.topic_id, t.title AS topic_title, s.id AS subject_id, s.name AS subject_name
       FROM maps m
       LEFT JOIN plans p ON p.id = m.plan_id
       LEFT JOIN topics t ON t.id = m.topic_id
       LEFT JOIN subjects s ON s.id = m.subject_id
       WHERE CASE WHEN m.plan_id IS NULL THEN s.id IS NOT NULL
         ELSE t.id IS NOT NULL AND t.archived_at IS NULL END
       ORDER BY s.id IS NULL, s.position, s.name COLLATE NOCASE, s.id, m.plan_id IS NOT NULL,
         p.title COLLATE NOCASE, p.id, t.position, t.id`,
    )
    .all() as Row[];
  return rows.flatMap((row) =>
    parseCollection(row).maps.flatMap((map) => {
      if (words.length) {
        const text = foldText(
          [
            map.title,
            row.plan_title ?? "",
            row.topic_title ?? "",
            row.subject_name ?? "",
            ...map.graph.nodes.map((node) => node.label),
          ].join("\n"),
        );
        if (!words.every((word) => text.includes(word))) return [];
      }
      return [
        {
          id: map.id,
          title: map.title,
          planId: row.plan_id,
          planTitle: row.plan_title,
          topicId: row.topic_id,
          topicTitle: row.topic_title,
          subjectId: row.subject_id,
          subjectName: row.subject_name,
          nodeCount: map.graph.nodes.length,
          shape: mapShape(map.graph),
          grounding:
            map.grounding ?? (map.passageIds.length ? "sources" : "general"),
        },
      ];
    }),
  );
}

/**
 * The map's outline for its tile: for each branch of the root, in order, how many concepts sit under it at any depth.
 * Only the first branches and concepts fit the drawing, so both are capped.
 */
export function mapShape(graph: Pick<ConceptGraph, "nodes">): number[] {
  const root = graph.nodes.find((node) => node.parent === null);
  if (!root) return [];
  const children = new Map<string, string[]>();
  for (const node of graph.nodes)
    if (node.parent) children.set(node.parent, [...(children.get(node.parent) ?? []), node.id]);
  // Counts what hangs under a branch, stopping once the drawing is full; `seen` guards against a cycle in saved data.
  const under = (id: string, seen: Set<string>): number => {
    let count = 0;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child) || count >= MAP_SHAPE.leaves) continue;
      seen.add(child);
      count += 1 + under(child, seen);
    }
    return count;
  };
  return graph.nodes
    .filter((node) => node.parent === root.id)
    .slice(0, MAP_SHAPE.branches)
    .map((branch) => Math.min(under(branch.id, new Set([root.id, branch.id])), MAP_SHAPE.leaves));
}
