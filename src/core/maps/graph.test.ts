import { describe, expect, it } from "vitest";
import { applyOps, branchFromInstruction, layoutGraph, undoGraph, type ConceptGraph } from "./graph";

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
    expect(child?.y).toBe(110);
    expect(child?.x).not.toBe(tree.nodes.find((node) => node.id === "b")?.x);
    const pinned = layoutGraph({
      ...tree,
      nodes: tree.nodes.map((node) =>
        node.id === "a" ? { ...node, x: 40, y: 70, pinned: true } : node,
      ),
    });
    expect(pinned.nodes.find((node) => node.id === "a")).toMatchObject({ x: 40, y: 70 });
  });

  it("puts children on a ring in the radial layout", () => {
    const radial = layoutGraph({ ...sample(), layout: "radial" });
    const root = radial.nodes.find((node) => node.id === "root");
    const child = radial.nodes.find((node) => node.id === "a");
    expect(root).toMatchObject({ x: 0, y: 0 });
    expect(Math.hypot(child?.x ?? 0, child?.y ?? 0)).toBeGreaterThan(200);
    const many = layoutGraph({
      layout: "radial",
      undo: null,
      edges: [],
      nodes: [
        { id: "root", label: "Moti", parent: null, x: 0, y: 0, pinned: false },
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `n${index}`,
          label: `n${index}`,
          parent: "root",
          x: 0,
          y: 0,
          pinned: false,
        })),
      ],
    });
    const first = many.nodes.find((node) => node.id === "n0");
    const second = many.nodes.find((node) => node.id === "n1");
    const gap = Math.hypot((first?.x ?? 0) - (second?.x ?? 0), (first?.y ?? 0) - (second?.y ?? 0));
    expect(gap).toBeGreaterThan(140);
  });

  it("applies one patch and undoes it", () => {
    const next = applyOps(sample(), [
      { op: "add_node", id: "c", label: "Catena", parent: "a" },
      { op: "rename", id: "b", label: "Velocità" },
    ]);
    expect(next.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c", "root"]);
    expect(next.nodes.find((node) => node.id === "b")?.label).toBe("Velocità");
    const back = undoGraph(next);
    expect(back.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "root"]);
    expect(back.undo).toBeNull();
    const old = sample();
    old.layout = "radial";
    old.undo = { nodes: old.nodes.map((node) => ({ ...node })), edges: old.edges.map((edge) => ({ ...edge })) };
    expect(undoGraph(old).layout).toBe("radial");
    expect(() => applyOps(sample(), [{ op: "rename", id: "missing", label: "x" }])).toThrow(
      /map-missing/,
    );
  });

  it("turns one instruction into one undoable branch", () => {
    const label = branchFromInstruction("aggiungi un ramo sulla regola della catena");
    expect(label).toBe("regola della catena");
    const next = applyOps(sample(), [
      { op: "add_node", id: "c", label: label ?? "", parent: "root" },
    ]);
    expect(next.nodes.find((node) => node.id === "c")?.label).toBe("regola della catena");
    expect(undoGraph(next).nodes.some((node) => node.id === "c")).toBe(false);
  });
});
