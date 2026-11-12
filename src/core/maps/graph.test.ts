import { describe, expect, it } from "vitest";
import {
  applyOps,
  layoutGraph,
  undoGraph,
  redoGraph,
  type ConceptGraph,
} from "./graph";

function sample(): ConceptGraph {
  return layoutGraph({
    layout: "tree",
    undo: null,
    nodes: [
      { id: "root", label: "Moti", parent: null, x: 0, y: 0, pinned: false },
      { id: "a", label: "Vettore", parent: "root", x: 0, y: 0, pinned: false },
      { id: "b", label: "Velocita", parent: "root", x: 0, y: 0, pinned: false },
    ],
    edges: [
      { from: "root", to: "a" },
      { from: "root", to: "b" },
    ],
  });
}

describe("concept map", () => {
  it("spreads a tree and keeps a dragged node", () => {
    const tree = sample();
    const child = tree.nodes.find((node) => node.id === "a");
    expect(child?.y).toBe(160);
    expect(child?.x).not.toBe(tree.nodes.find((node) => node.id === "b")?.x);
    const pinned = layoutGraph({
      ...tree,
      nodes: tree.nodes.map((node) =>
        node.id === "a" ? { ...node, x: 40, y: 70, pinned: true } : node,
      ),
    });
    expect(pinned.nodes.find((node) => node.id === "a")).toMatchObject({
      x: 40,
      y: 70,
    });
  });

  it("leaves the positions of a radial map as they are, since the page and the export plan them", () => {
    const stored = sample().nodes.map((node) => ({ ...node, x: node.x + 7, y: node.y + 3 }));
    const radial = layoutGraph({ ...sample(), layout: "radial", nodes: stored });
    expect(radial.nodes).toEqual(stored);
  });

  it("applies one patch and undoes it", () => {
    const next = applyOps(sample(), [
      { op: "add_node", id: "c", label: "Catena", parent: "a" },
      { op: "rename", id: "b", label: "Velocità" },
    ]);
    expect(next.nodes.map((node) => node.id).sort()).toEqual([
      "a",
      "b",
      "c",
      "root",
    ]);
    expect(next.nodes.find((node) => node.id === "b")?.label).toBe("Velocità");
    const back = undoGraph(next);
    expect(back.nodes.map((node) => node.id).sort()).toEqual([
      "a",
      "b",
      "root",
    ]);
    expect(back.undo).toBeNull();
    const old = sample();
    old.layout = "radial";
    old.undo = {
      nodes: old.nodes.map((node) => ({ ...node })),
      edges: old.edges.map((edge) => ({ ...edge })),
    };
    expect(undoGraph(old).layout).toBe("radial");
    expect(() =>
      applyOps(sample(), [{ op: "rename", id: "missing", label: "x" }]),
    ).toThrow(/map-missing/);
  });
});

it("redos an undone patch and discards redo when a new edit branches", () => {
  const graph: ConceptGraph = {
    layout: "tree",
    nodes: [
      { id: "root", parent: null, label: "Before", x: 14, y: 9, pinned: true },
    ],
    edges: [],
    undo: null,
  };
  const edited = applyOps(graph, [
    { op: "rename", id: "root", label: "After" },
  ]);
  const undone = undoGraph(edited);
  expect(undone.nodes[0]?.label).toBe("Before");
  const redone = redoGraph(undone);
  expect(redone.nodes).toEqual(edited.nodes);
  expect(redone.redo).toBeNull();
  const branch = applyOps(undone, [
    { op: "rename", id: "root", label: "Branch" },
  ]);
  expect(branch.redo).toBeNull();
  expect(redoGraph(branch).nodes[0]?.label).toBe("Branch");
});
