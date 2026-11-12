import { describe, expect, it } from "vitest";
import { NODE_WIDTH } from "../../shared/map-layout";
import { openDatabase } from "../db/connection";
import { exportMap, mapOutline, mapSvg, wrapText } from "./export";
import type { ConceptGraph } from "./graph";
import { storeMap } from "./store";
import { drawingProblems } from "../../../tests/fixtures/map-svg";
import { filmHistory, physics, radialFixtures, storedGraph } from "../../../tests/fixtures/maps";

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

  it("keeps a dragged concept of a radial map where it was dropped and plans the rest around the root", () => {
    const radial: ConceptGraph = {
      layout: "radial",
      undo: null,
      nodes: [node("a", "A", null), node("b", "B", "a", { x: 400, y: 300, pinned: true })],
      edges: [{ from: "a", to: "b" }],
    };
    const svg = mapSvg("A", radial);
    // The root is centred on 0,0 by the plan, a 240 by 64 box, so it starts at -120,-32; the drawing starts 40 before that.
    expect(svg).toContain('<rect x="40" y="40" width="240" height="64"');
    expect(svg).toContain('<rect x="560" y="372" width="240" height="64"');
  });

  it("keeps an edge that bows past the leftmost node inside the drawing", () => {
    // The child sits almost over its parent and a little to the left, so the curve swings out to the left of both.
    const bowed: ConceptGraph = {
      layout: "radial",
      undo: null,
      nodes: [
        node("a", "A", null, { x: 0, y: 0 }),
        node("b", "B", "a", { x: -10, y: 300 }),
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const svg = mapSvg("A", bowed);
    const width = Number(/width="(\d+)"/.exec(svg)![1]);
    const numbers = /<path d="([^"]+)"/.exec(svg)![1]!.match(/-?[\d.]+/g)!;
    const xs = numbers.filter((_, i) => i % 2 === 0).map(Number);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(width);
    }
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
    storeMap(db, { planId: "p", topicId: "t" }, {
      id: "m1",
      title: "Derivate: regole/casi",
      passageIds: [],
      graph,
    });
    const file = exportMap(db, { planId: "p", topicId: "t" }, {
      mapId: "m1",
      language: "en",
    });
    expect(file.filename).toBe("Derivate regole casi.md");
    expect(file.markdown).toContain("Exam: Analisi 1 · Topic: Derivate");
    expect(file.svg).toContain("<svg");
    expect(() =>
      exportMap(db, { planId: "p", topicId: "t" }, {
        mapId: "nope",
        language: "en",
      }),
    ).toThrow("map-missing");
  });

  it("names the subject of a whole-subject map", () => {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO subjects(id,name,position,created_at) VALUES('s','Analisi I',0,1);`);
    storeMap(db, { subjectId: "s" }, { id: "m1", title: "Analisi", passageIds: [], graph });
    const file = exportMap(db, { subjectId: "s" }, { language: "it" });
    expect(file.markdown).toContain("Materia: Analisi I\n");
    expect(file.markdown).not.toContain("Esame:");
  });
});

// How far the root's middle may be from the drawing's middle, as a share of its size. A branch of twenty leaves fans out
// on its own side, so that map keeps the root only inside the middle half, and a chain of single branches grows one way
// from its root, which is not in the middle at all.
describe.each([
  ["film history", filmHistory, 0.1],
  ["60 concepts", physics, 0.1],
  ["twelve leaves", radialFixtures.twelveLeaves, 0.1],
  ["one big branch", radialFixtures.oneBigBranch, 0.25],
  ["six levels", radialFixtures.deepChain, null],
])("mapSvg of the radial map %s", (_, fixture, off) => {
  const map = storedGraph(fixture, "radial") as ConceptGraph;
  const problems = drawingProblems(mapSvg(fixture.title, map), map);

  it("draws no two concept boxes over each other", () => {
    expect(problems.overlaps).toEqual([]);
  });

  it("draws no link through a box that is not one of its ends", () => {
    expect(problems.behind).toEqual([]);
  });

  it("puts the root in the middle of the drawing", () => {
    if (off === null) return;
    expect(problems.rootOffset.x).toBeLessThan(off);
    expect(problems.rootOffset.y).toBeLessThan(off);
  });

  it("leaves out the links outside the hierarchy, which would run behind other concepts", () => {
    const svg = mapSvg(fixture.title, map);
    expect(svg).not.toMatch(/stroke-dasharray="6 5"[^>]*><path/);
    for (const link of fixture.links) expect(svg).not.toContain(`>${link.label}</tspan>`);
  });
});
