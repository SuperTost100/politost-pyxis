export type MapNode = {
  id: string;
  label: string;
  parent: string | null;
  x: number;
  y: number;
  pinned: boolean;
  color?: string;
};

export type MapEdge = { from: string; to: string };

export type ConceptGraph = {
  layout: "tree" | "radial";
  nodes: MapNode[];
  edges: MapEdge[];
  undo: { nodes: MapNode[]; edges: MapEdge[] } | null;
};

export type MapOp =
  | { op: "add_node"; id: string; label: string; parent: string }
  | { op: "rename"; id: string; label: string }
  | { op: "delete"; id: string }
  | { op: "connect"; from: string; to: string }
  | { op: "disconnect"; from: string; to: string }
  | { op: "recolor"; id: string; color: string };

const GAP_X = 180;
const GAP_Y = 110;

export function layoutGraph(graph: ConceptGraph): ConceptGraph {
  const nodes = graph.nodes.map((node) => ({ ...node }));
  if (graph.layout === "radial") placeRadial(nodes);
  else placeTree(nodes);
  return { ...graph, nodes };
}

export function applyOps(graph: ConceptGraph, ops: MapOp[]): ConceptGraph {
  const undo = {
    nodes: graph.nodes.map((node) => ({ ...node })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
  let nodes = undo.nodes.map((node) => ({ ...node }));
  let edges = undo.edges.map((edge) => ({ ...edge }));
  for (const op of ops) {
    const next = applyOne(nodes, edges, op);
    nodes = next.nodes;
    edges = next.edges;
  }
  return layoutGraph({ ...graph, nodes, edges, undo });
}

export function undoGraph(graph: ConceptGraph): ConceptGraph {
  if (!graph.undo) return graph;
  return layoutGraph({
    ...graph,
    nodes: graph.undo.nodes.map((node) => ({ ...node })),
    edges: graph.undo.edges.map((edge) => ({ ...edge })),
    undo: null,
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
        { id: op.id, label: op.label, parent: op.parent, x: 0, y: 0, pinned: false },
      ],
      edges: [...edges, { from: op.parent, to: op.id }],
    };
  }
  if (!("id" in op) && op.op !== "connect" && op.op !== "disconnect") return { nodes, edges };
  if (op.op === "rename" || op.op === "recolor" || op.op === "delete") {
    if (!ids.has(op.id)) throw new Error("map-missing");
  }
  if (op.op === "rename") {
    return {
      nodes: nodes.map((node) => (node.id === op.id ? { ...node, label: op.label } : node)),
      edges,
    };
  }
  if (op.op === "recolor") {
    return {
      nodes: nodes.map((node) => (node.id === op.id ? { ...node, color: op.color } : node)),
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
    if (edges.some((edge) => edge.from === op.from && edge.to === op.to)) return { nodes, edges };
    return { nodes, edges: [...edges, { from: op.from, to: op.to }] };
  }
  return {
    nodes,
    edges: edges.filter((edge) => !(edge.from === op.from && edge.to === op.to)),
  };
}

function placeTree(nodes: MapNode[]): void {
  const depths = depthOf(nodes);
  const rows = new Map<number, MapNode[]>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const row = rows.get(depth) ?? [];
    row.push(node);
    rows.set(depth, row);
  }
  for (const [depth, row] of rows) {
    row.forEach((node, index) => {
      if (node.pinned) return;
      node.x = (index - (row.length - 1) / 2) * GAP_X;
      node.y = depth * GAP_Y;
    });
  }
}

function placeRadial(nodes: MapNode[]): void {
  const root = nodes.find((node) => node.parent == null) ?? nodes[0];
  if (!root) return;
  if (!root.pinned) {
    root.x = 0;
    root.y = 0;
  }
  const children = nodes.filter((node) => node.parent != null);
  children.forEach((node, index) => {
    if (node.pinned) return;
    const angle = (index / Math.max(children.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const ring = node.parent === root.id ? 220 : 360;
    node.x = Math.round(Math.cos(angle) * ring);
    node.y = Math.round(Math.sin(angle) * ring);
  });
}

function depthOf(nodes: MapNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  function walk(id: string, seen: Set<string>): number {
    const known = depths.get(id);
    if (known != null) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parent = byId.get(id)?.parent;
    const depth = parent ? walk(parent, seen) + 1 : 0;
    depths.set(id, depth);
    return depth;
  }
  for (const node of nodes) walk(node.id, new Set());
  return depths;
}
