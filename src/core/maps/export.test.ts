import { describe, expect, it } from "vitest";
import { NODE_WIDTH } from "../../shared/map-layout";
import { openDatabase } from "../db/connection";
import { exportMap, mapOutline, mapSvg, wrapText } from "./export";
import type { ConceptGraph } from "./graph";
import { storeMap } from "./store";

const node = (
  id: string,
  label: string,
  parent: string | null,
  extra: Partial<ConceptGraph["nodes"][number]> = {},
) => ({ id, label, parent, x: 0, y: 0, pinned: false, ...extra });

const graph: ConceptGraph = {
  layout: "tree",
  undo: null,
  nodes: [
    node("root", "Derivate", null),
    node("rate", "Tasso di variazione", "root"),
    node("rules", "Regole", "root"),
    node("product", "Regola del **prodotto** $f'g+fg'$", "rules"),
    node("chain", "Regola della catena", "rules", { color: "star-soft" }),
    node("tangent", 'Tangente <e> & "retta"', "root"),
  ],
  edges: [
    { from: "root", to: "rate", label: "misura" },
    { from: "root", to: "rules" },
    { from: "rules", to: "product" },
    { from: "rules", to: "chain" },
    { from: "root", to: "tangent" },
    { from: "chain", to: "tangent", label: "usa la pendenza" },
    { from: "product", to: "rate" },
  ],
};

describe("mapOutline", () => {
  it("nests every branch under the root, leads with tree-edge labels and lists the cross-links", () => {
    expect(
      mapOutline(
        "Derivate",
        graph,
        { planTitle: "Analisi 1", topicTitle: "Derivate" },
        "it",
      ),
    ).toBe(
      [
        "# Derivate",
        "",
        "Esame: Analisi 1 · Argomento: Derivate",
        "",
        "- Derivate",
        "  - *misura:* Tasso di variazione",
        "  - Regole",
        "    - Regola del **prodotto** $f'g+fg'$",
        "    - Regola della catena",
        '  - Tangente <e> & "retta"',
        "",
        "## Collegamenti",
        "",
        '- Regola della catena → Tangente <e> & "retta": *usa la pendenza*',
        "- Regola del **prodotto** $f'g+fg'$ → Tasso di variazione",
        "",
      ].join("\n"),
    );
  });

  it("leaves out the cross-link section when there is none", () => {
    const tree = {
      ...graph,
      edges: graph.edges.filter(
        (edge) => edge.from !== "chain" && edge.from !== "product",
      ),
    };
    const outline = mapOutline("Mappa", tree, {
      planTitle: "Esame",
      topicTitle: "Tema",
    });
    expect(outline).toContain("Exam: Esame · Topic: Tema");
    expect(outline).not.toContain("## Cross-links");
  });
});

describe("mapSvg", () => {
  it("draws every node, folded or not, inside the drawing, with escaped text and plain labels", () => {
    const svg = mapSvg("Derivate & co", graph);
    const width = Number(/width="(\d+)"/.exec(svg)![1]);
    const height = Number(/height="(\d+)"/.exec(svg)![1]);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(svg).toContain("<title>Derivate &amp; co</title>");
    expect(svg).toContain("Tangente &lt;e&gt; &amp; &quot;retta&quot;");
    // Long labels wrap into lines and the node grows to hold them.
    expect(svg).toMatch(
      /height="70" [^>]*\/><text[^>]*><tspan[^>]*>Regola del prodotto<\/tspan><tspan[^>]*>f'g\+fg'<\/tspan>/,
    );
    expect(svg).not.toContain("**");
    // A labelled cross-link shows its label; tree edges do not.
    expect(svg).toContain("usa la pendenza");
    expect(svg).not.toContain(">misura<");
    expect(svg).toContain('fill="#fbf0d6"');
    const rects = [
      ...svg.matchAll(
        /<rect x="([\d.]+)" y="([\d.]+)" width="240" height="(\d+)" rx="12"/g,
      ),
    ];
    expect(rects).toHaveLength(graph.nodes.length);
    for (const [, x, y, h] of rects) {
      expect(Number(x)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(x) + NODE_WIDTH).toBeLessThanOrEqual(width);
      expect(Number(y) + Number(h)).toBeLessThanOrEqual(height);
    }
  });

  it("keeps a dragged node where it was dropped and lays out the rest left to right", () => {
    const pinned = {
      ...graph,
      nodes: graph.nodes.map((item) =>
        item.id === "tangent"
          ? { ...item, x: 2000, y: -900, pinned: true }
          : item,
      ),
    };
    const svg = mapSvg("Derivate", pinned);
    const width = Number(/width="(\d+)"/.exec(svg)![1]);
    const height = Number(/height="(\d+)"/.exec(svg)![1]);
    // The drawing reaches from the root at x 0 to the dropped node, 900 above the tree.
    expect(width).toBe(2000 + NODE_WIDTH + 2 * 40);
    expect(height).toBeGreaterThan(900);
  });

  it("uses saved positions for the radial layout", () => {
    const radial: ConceptGraph = {
      layout: "radial",
      undo: null,
      nodes: [
        node("a", "A", null, { x: -100, y: -50 }),
        node("b", "B", "a", { x: 400, y: 300 }),
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const svg = mapSvg("A", radial);
    expect(/width="(\d+)"/.exec(svg)![1]).toBe(String(500 + NODE_WIDTH + 80));
    expect(svg).toContain('<rect x="40" y="40" width="240"');
    expect(svg).toContain('<rect x="540" y="390" width="240"');
  });
});

describe("wrapText", () => {
  it("wraps at word boundaries and cuts a word longer than a line", () => {
    expect(wrapText("uno due tre quattro", 8)).toEqual([
      "uno due",
      "tre",
      "quattro",
    ]);
    expect(wrapText("abcdefghij kl", 4)).toEqual(["abcd", "efgh", "ij", "kl"]);
    expect(wrapText("", 4)).toEqual([""]);
  });
});

describe("exportMap", () => {
  it("names the files after the map and fails for a map that is not there", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Analisi 1','ready',1,1);
      INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('t','p','Derivate',0,1);
    `);
    storeMap(db, "p", "t", {
      id: "m1",
      title: "Derivate: regole/casi",
      passageIds: [],
      graph,
    });
    const file = exportMap(db, {
      planId: "p",
      topicId: "t",
      mapId: "m1",
      language: "en",
    });
    expect(file.filename).toBe("Derivate regole casi.md");
    expect(file.markdown).toContain("Exam: Analisi 1 · Topic: Derivate");
    expect(file.svg).toContain("<svg");
    expect(() =>
      exportMap(db, {
        planId: "p",
        topicId: "t",
        mapId: "nope",
        language: "en",
      }),
    ).toThrow("map-missing");
  });
});
