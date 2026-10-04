import { hierarchy, tree } from "d3-hierarchy";
import {
  conceptGraphSchema,
  mapOpSchema,
  type ConceptGraph,
  type MapOp,
} from "../../shared/concept-map";
export type { ConceptGraph, MapOp };
export type MapNode = ConceptGraph["nodes"][number];
export type MapEdge = ConceptGraph["edges"][number];

export function validateGraph(graph: ConceptGraph): void {
  conceptGraphSchema.parse(graph);
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length) throw new Error("map-duplicate");
  if (graph.nodes.filter((node) => node.parent === null).length !== 1)
    throw new Error("map-root");
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    const seen = new Set([node.id]);
    let parent = node.parent;
    while (parent !== null) {
      if (!ids.has(parent)) throw new Error("map-missing");
      if (seen.has(parent)) throw new Error("map-cycle");
      seen.add(parent);
      parent = byId.get(parent)!.parent;
    }
  }
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to))
      throw new Error("map-missing");
    const key = JSON.stringify([edge.from, edge.to]);
    if (edges.has(key)) throw new Error("map-duplicate-edge");
    edges.add(key);
  }
}

export function layoutGraph(graph: ConceptGraph): ConceptGraph {
  validateGraph(graph);
  const nodes = graph.nodes.map((node) => ({ ...node }));
  if (graph.layout === "radial") placeRadial(nodes);
  else placeTree(nodes);
  return { ...graph, nodes };
}

export function applyOps(graph: ConceptGraph, ops: MapOp[]): ConceptGraph {
  const undo = {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    layout: graph.layout,
  };
  let nodes = undo.nodes.map((node) => ({ ...node }));
  let edges = undo.edges.map((edge) => ({ ...edge }));
  for (const candidate of ops) {
    const op = mapOpSchema.parse(candidate);
    const next = applyOne(nodes, edges, op);
    nodes = next.nodes;
    edges = next.edges;
  }
  return layoutGraph({ ...graph, nodes, edges, undo, redo: null });
}

export function undoGraph(graph: ConceptGraph): ConceptGraph {
  if (!graph.undo) return graph;
  return layoutGraph({
    ...graph,
    layout: graph.undo.layout ?? graph.layout,
    nodes: graph.undo.nodes.map((node) => ({ ...node })),
    edges: graph.undo.edges.map((edge) => ({ ...edge })),
    undo: null,
    redo: {
      nodes: graph.nodes.map((node) => ({ ...node })),
      edges: graph.edges.map((edge) => ({ ...edge })),
      layout: graph.layout,
    },
  });
}

export function redoGraph(graph: ConceptGraph): ConceptGraph {
  if (!graph.redo) return graph;
  return layoutGraph({
    ...graph,
    nodes: graph.redo.nodes.map((node) => ({ ...node })),
    edges: graph.redo.edges.map((edge) => ({ ...edge })),
    layout: graph.redo.layout ?? graph.layout,
    undo: {
      nodes: graph.nodes.map((node) => ({ ...node })),
      edges: graph.edges.map((edge) => ({ ...edge })),
      layout: graph.layout,
    },
    redo: null,
  });
}

function applyOne(
  nodes: MapNode[],
  edges: MapEdge[],
  op: MapOp,
): { nodes: MapNode[]; edges: MapEdge[] } {
  const ids = new Set(nodes.map((node) => node.id));
  if (op.op === "add_node") {
    if (!ids.has(op.parent)) throw new Error("map-missing");
    if (ids.has(op.id)) throw new Error("map-duplicate");
    return {
      nodes: [
        ...nodes,
        {
          id: op.id,
          label: op.label,
          parent: op.parent,
          x: 0,
          y: 0,
          pinned: false,
        },
      ],
      edges: [...edges, { from: op.parent, to: op.id }],
    };
  }
  if (!("id" in op) && op.op !== "connect" && op.op !== "disconnect")
    return { nodes, edges };
  if (op.op === "rename" || op.op === "recolor" || op.op === "delete") {
    if (!ids.has(op.id)) throw new Error("map-missing");
  }
  if (op.op === "rename") {
    return {
      nodes: nodes.map((node) =>
        node.id === op.id ? { ...node, label: op.label } : node,
      ),
      edges,
    };
  }
  if (op.op === "recolor") {
    return {
      nodes: nodes.map((node) =>
        node.id === op.id ? { ...node, color: op.color } : node,
      ),
      edges,
    };
  }
  if (op.op === "delete") {
    const drop = new Set([op.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of nodes) {
        if (node.parent && drop.has(node.parent) && !drop.has(node.id)) {
          drop.add(node.id);
          grew = true;
        }
      }
    }
    return {
      nodes: nodes.filter((node) => !drop.has(node.id)),
      edges: edges.filter((edge) => !drop.has(edge.from) && !drop.has(edge.to)),
    };
  }
  if (op.op === "connect") {
    if (!ids.has(op.from) || !ids.has(op.to)) throw new Error("map-missing");
    if (edges.some((edge) => edge.from === op.from && edge.to === op.to))
      return { nodes, edges };
    return {
      nodes,
      edges: [
        ...edges,
        { from: op.from, to: op.to, ...(op.label ? { label: op.label } : {}) },
      ],
    };
  }
  if (!ids.has(op.from) || !ids.has(op.to)) throw new Error("map-missing");
  return {
    nodes,
    edges: edges.filter(
      (edge) => !(edge.from === op.from && edge.to === op.to),
    ),
  };
}

function rooted(nodes: MapNode[]) {
  return hierarchy(
    nodes.find((node) => node.parent === null)!,
    (node) => nodes.filter((child) => child.parent === node.id),
  );
}
function placeTree(nodes: MapNode[]): void {
  const placed = tree<MapNode>().nodeSize([240, 160])(rooted(nodes));
  placed.each((point) => {
    if (!point.data.pinned) {
      point.data.x = point.x;
      point.data.y = point.y;
    }
  });
}
function placeRadial(nodes: MapNode[]): void {
  const root = rooted(nodes);
  const maxDepth = Math.max(1, root.height);
  const outerRadius = Math.max(
    320 * maxDepth,
    (nodes.length * 250) / (2 * Math.PI),
  );
  const placed = tree<MapNode>().size([2 * Math.PI, outerRadius])(root);
  placed.each((point) => {
    if (point.data.pinned) return;
    point.data.x = Math.round(Math.sin(point.x) * point.y);
    point.data.y = Math.round(-Math.cos(point.x) * point.y);
  });
}
