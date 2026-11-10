import { describe, expect, it } from "vitest";
import { layoutGraph, type ConceptGraph } from "./graph";
import { mergeGraphs } from "./merge";

type Spec = [id: string, label: string, parent: string | null, sources?: string[]];
function part(nodes: Spec[], links: Array<[string, string, string?]> = []): ConceptGraph {
  const edges = nodes
    .filter(([, , parent]) => parent)
    .map(([id, , parent]) => ({ from: parent!, to: id }));
  return {
    layout: "tree",
    undo: null,
    nodes: nodes.map(([id, label, parent, sources]) => ({
      id,
      label,
      parent,
      x: 0,
      y: 0,
      pinned: false,
      ...(sources ? { sources } : {}),
    })),
    edges: [...edges, ...links.map(([from, to, label]) => ({ from, to, ...(label ? { label } : {}) }))],
  };
}

describe("mergeGraphs", () => {
  it("keeps one part as it is and names its root after the request", () => {
    const only = part([["root", "Cinematica", null], ["a", "Velocità", "root"]]);
    const merged = mergeGraphs("Fisica", [only]);
    expect(merged.nodes.map((node) => node.label)).toEqual(["Fisica", "Velocità"]);
    expect(merged.edges).toEqual(only.edges);
  });

  it("merges each part's root into the map's root, so the first level is the parts' own concepts", () => {
    const one = part([["root", "Fisica, cinematica e dinamica del punto materiale", null], ["a", "Velocità", "root"]]);
    const two = part([["root", "Fisica, cinematica…", null], ["a", "Accelerazione", "root"], ["b", "Forza", "a"]]);
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    const root = merged.nodes.find((node) => node.parent === null)!;
    expect(root.label).toBe("Fisica");
    expect(merged.nodes.filter((node) => node.parent === root.id).map((node) => node.label)).toEqual([
      "Velocità",
      "Accelerazione",
    ]);
    // Neither part's root label survives as a node, and both parts' IDs stay unique.
    expect(merged.nodes.map((node) => node.label)).toEqual(["Fisica", "Velocità", "Accelerazione", "Forza"]);
    expect(new Set(merged.nodes.map((node) => node.id)).size).toBe(4);
    const accel = merged.nodes.find((node) => node.label === "Accelerazione")!;
    expect(merged.edges).toContainEqual({ from: root.id, to: accel.id });
  });

  it("keeps a concept named the same in two parts once, with the first spelling, the later children and every source", () => {
    const one = part([
      ["r1", "Uno", null, ["p1"]],
      ["m", "Moto", "r1", ["p1"]],
      ["x", "Rettilineo", "m", ["p1"]],
    ]);
    const two = part(
      [
        ["r2", "Due", null, ["p2"]],
        ["m", "  MOTO ", "r2", ["p2"]],
        ["y", "Circolare", "m", ["p2"]],
        ["z", "Armonico", "r2", ["p2"]],
      ],
      [["z", "m", "è un tipo di"]],
    );
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    // The parts' roots only name the parts, so their sources go to the map's root.
    expect(merged.nodes.find((node) => node.parent === null)!.sources).toEqual(["p1", "p2"]);
    const moto = merged.nodes.filter((node) => node.label.trim().toLowerCase() === "moto");
    expect(moto).toHaveLength(1);
    expect(moto[0]!.label).toBe("Moto");
    expect(moto[0]!.sources).toEqual(["p1", "p2"]);
    const under = (id: string) => merged.nodes.filter((node) => node.parent === id).map((node) => node.label);
    expect(under(moto[0]!.id)).toEqual(["Rettilineo", "Circolare"]);
    // The link from the second part follows its concept to the node that was kept.
    const zed = merged.nodes.find((node) => node.label === "Armonico")!;
    expect(merged.edges).toContainEqual({ from: zed.id, to: moto[0]!.id, label: "è un tipo di" });
    expect(merged.nodes).toHaveLength(1 + 1 + 2 + 1);
  });

  it("drops links that end up joining a concept to itself and links it already has", () => {
    const one = part([["r", "Uno", null], ["a", "Alfa", "r"], ["b", "Beta", "r"]], [["a", "b", "come"]]);
    const two = part([["r", "Due", null], ["a", "ALFA", "r"], ["b", "beta", "r"]], [["a", "b", "come"], ["a", "a"]]);
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    expect(merged.edges.filter((edge) => edge.label === "come")).toHaveLength(1);
    expect(merged.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });
});
