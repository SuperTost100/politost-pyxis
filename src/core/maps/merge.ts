import { childrenOf } from "../../shared/map-layout";
import type { ConceptGraph, MapEdge, MapNode } from "./graph";

const nameOf = (label: string) => label.trim().toLocaleLowerCase();
const MAX_SOURCES = 500;

/**
 * Joins the maps of the parts one request was read in into a single map. Its root is the request's own name (the topic's
 * or the subject's) and each part's root merges into it whatever its label, keeping its sources, so the first level is
 * made of the parts' own first-level concepts. A concept that two parts name the same, ignoring
 * case and the spaces around it, is kept once: the first spelling stays, the later one's children move under it, and
 * its sources and links are added to it. One part needs no joining, so its map is kept as it is and only its root takes
 * the name.
 *
 * Nodes keep the IDs the model gave them; a later part's ID that is already taken gets a number after it.
 */
export function mergeGraphs(title: string, graphs: ConceptGraph[]): ConceptGraph {
  if (graphs.length === 1) {
    const [only] = graphs as [ConceptGraph];
    return {
      ...only,
      nodes: only.nodes.map((node) => (node.parent === null ? { ...node, label: title } : node)),
    };
  }
  const used = new Set<string>();
  const fresh = (wanted: string) => {
    let id = wanted;
    for (let n = 2; used.has(id); n++) id = `${wanted.slice(0, 150)}-${n}`;
    used.add(id);
    return id;
  };
  const root: MapNode = { id: fresh("root"), label: title, parent: null, x: 0, y: 0, pinned: false };
  const nodes = [root];
  const byName = new Map([[nameOf(title), root]]);
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  const link = (edge: MapEdge) => {
    const key = JSON.stringify([edge.from, edge.to]);
    if (edge.from === edge.to || seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };
  const partEdges: MapEdge[][] = [];
  for (const graph of graphs) {
    const children = childrenOf(graph.nodes);
    const placed = new Map<string, string>();
    // Parents come before their children, so a dropped duplicate only ever sends its children to an earlier node.
    const walk = (node: MapNode, parent: MapNode) => {
      let at = byName.get(nameOf(node.label));
      if (at) {
        if (node.sources?.length)
          at.sources = [...new Set([...(at.sources ?? []), ...node.sources])].slice(0, MAX_SOURCES);
      } else {
        at = { ...node, id: fresh(node.id), parent: parent.id, sources: node.sources && [...node.sources] };
        if (!at.sources) delete at.sources;
        nodes.push(at);
        byName.set(nameOf(node.label), at);
      }
      placed.set(node.id, at.id);
      for (const child of children.get(node.id) ?? []) walk(child, at);
    };
    // A part's root only names the part, so it joins the map's root: the first level is the parts' own concepts.
    const start = graph.nodes.find((node) => node.parent === null);
    if (start) {
      if (start.sources?.length) root.sources = [...new Set([...(root.sources ?? []), ...start.sources])].slice(0, MAX_SOURCES);
      placed.set(start.id, root.id);
      for (const child of children.get(start.id) ?? []) walk(child, root);
    }
    partEdges.push(
      graph.edges.map((edge) => ({
        ...edge,
        from: placed.get(edge.from) ?? edge.from,
        to: placed.get(edge.to) ?? edge.to,
      })),
    );
  }
  for (const list of partEdges) for (const edge of list) link(edge);
  for (const node of nodes) if (node.parent !== null) link({ from: node.parent, to: node.id });
  return { layout: graphs[0]!.layout, undo: null, nodes, edges };
}
