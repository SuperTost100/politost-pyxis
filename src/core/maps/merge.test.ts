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

  it("makes each part's root a main branch under the map's root, with its own name", () => {
    const one = part([["root", "Cinematica", null, ["p1"]], ["a", "Velocità", "root", ["p1"]], ["b", "Moto", "a", ["p1"]]]);
    const two = part([["root", "Dinamica", null, ["p2"]], ["a", "Forza", "root", ["p2"]], ["b", "Massa", "root", ["p2"]]]);
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    const root = merged.nodes.find((node) => node.parent === null)!;
    expect(root.label).toBe("Fisica");
    const under = (id: string) => merged.nodes.filter((node) => node.parent === id);
    expect(under(root.id).map((node) => node.label)).toEqual(["Cinematica", "Dinamica"]);
    const dinamica = under(root.id)[1]!;
    expect(dinamica.sources).toEqual(["p2"]);
    expect(under(dinamica.id).map((node) => node.label)).toEqual(["Forza", "Massa"]);
    // Both parts used the IDs "root", "a" and "b", and every one is still unique.
    expect(merged.nodes).toHaveLength(7);
    expect(new Set(merged.nodes.map((node) => node.id)).size).toBe(7);
    expect(merged.edges).toContainEqual({ from: root.id, to: dinamica.id });
  });

  it("folds a part root that repeats the title into the map's root, whatever its case and spaces", () => {
    const one = part([["root", "Cinematica", null], ["a", "Velocità", "root"]]);
    const two = part([["root", "  FISICA ", null, ["p2"]], ["a", "Forza", "root", ["p2"]], ["b", "Massa", "a"]]);
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    const root = merged.nodes.find((node) => node.parent === null)!;
    expect(merged.nodes.map((node) => node.label)).toEqual(["Fisica", "Cinematica", "Velocità", "Forza", "Massa"]);
    expect(merged.nodes.filter((node) => node.parent === root.id).map((node) => node.label)).toEqual([
      "Cinematica",
      "Forza",
    ]);
    expect(root.sources).toEqual(["p2"]);
  });

  it("merges two parts that came back with the same root label into one branch", () => {
    const one = part([["r", "Energia", null, ["p1"]], ["a", "Lavoro", "r", ["p1"]]]);
    const two = part([["r", " energia ", null, ["p2"]], ["a", "Potenza", "r", ["p2"]], ["b", "Lavoro", "r", ["p2"]]]);
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    const root = merged.nodes.find((node) => node.parent === null)!;
    const branches = merged.nodes.filter((node) => node.parent === root.id);
    expect(branches.map((node) => node.label)).toEqual(["Energia"]);
    expect(branches[0]!.sources).toEqual(["p1", "p2"]);
    const children = merged.nodes.filter((node) => node.parent === branches[0]!.id);
    expect(children.map((node) => node.label)).toEqual(["Lavoro", "Potenza"]);
    expect(children[0]!.sources).toEqual(["p1", "p2"]);
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
    const moto = merged.nodes.filter((node) => node.label.trim().toLowerCase() === "moto");
    expect(moto).toHaveLength(1);
    expect(moto[0]!.label).toBe("Moto");
    expect(moto[0]!.sources).toEqual(["p1", "p2"]);
    const under = (id: string) => merged.nodes.filter((node) => node.parent === id).map((node) => node.label);
    expect(under(moto[0]!.id)).toEqual(["Rettilineo", "Circolare"]);
    // The link from the second part follows its concept to the node that was kept.
    const zed = merged.nodes.find((node) => node.label === "Armonico")!;
    expect(merged.edges).toContainEqual({ from: zed.id, to: moto[0]!.id, label: "è un tipo di" });
    // The root, both parts' roots, the shared concept, its two children and the one concept of the second part.
    expect(merged.nodes).toHaveLength(1 + 2 + 1 + 2 + 1);
    expect(under(merged.nodes.find((node) => node.label === "Due")!.id)).toEqual(["Armonico"]);
  });

  it("drops links that end up joining a concept to itself and links it already has", () => {
    const one = part([["r", "Uno", null], ["a", "Alfa", "r"], ["b", "Beta", "r"]], [["a", "b", "come"]]);
    const two = part([["r", "Due", null], ["a", "ALFA", "r"], ["b", "beta", "r"]], [["a", "b", "come"], ["a", "a"]]);
    const merged = layoutGraph(mergeGraphs("Fisica", [one, two]));
    expect(merged.edges.filter((edge) => edge.label === "come")).toHaveLength(1);
    expect(merged.edges.every((edge) => edge.from !== edge.to)).toBe(true);
  });
});
