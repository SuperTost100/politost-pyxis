import { describe, expect, it } from "vitest";
import { DOT_DEFAULTS, DOT_EDGES_MAX, DOT_NODES_MAX, checkDot, styledDot } from "./dot";
import {
  FIGURE_KINDS,
  drawableKinds,
  figureKind,
  figureKinds,
  figureProblem,
  graphLayout,
} from "./figure-kinds";

it("reads the kind a block names: a plot when it names none, nothing for a kind this Pyxis does not draw", () => {
  expect(figureKinds).toEqual(["plot", "circuit", "graph"]);
  expect(figureKind(undefined)).toBe("plot");
  expect(figureKind(null)).toBe("plot");
  expect(figureKind("  ")).toBe("plot");
  expect(figureKind("circuit")).toBe("circuit");
  expect(figureKind(" Circuit ")).toBe("circuit");
  expect(figureKind("graph")).toBe("graph");
  expect(figureKind("molecule")).toBeNull();
  expect(figureKind("constructor")).toBeNull();
  expect(figureKind(7)).toBeNull();
});

it("holds a circuit to 4,000 characters and 8 seconds, with a message the model can act on", () => {
  expect(FIGURE_KINDS.circuit).toMatchObject({ codeMax: 4000, timeoutMs: 8000 });
  expect(figureProblem("circuit", "d += elm.Resistor()")).toBeNull();
  expect(figureProblem("circuit", "x".repeat(4000))).toBeNull();
  expect(figureProblem("circuit", "x".repeat(4001))).toBe(
    "the code has 4001 characters: keep it within 4000",
  );
  expect(figureProblem("plot", "x".repeat(4001))).not.toBeNull();
});

it("draws a plot with Python alone, a circuit with both packs, and a graph with the drawing pack alone", () => {
  expect(drawableKinds(() => true)).toEqual(["plot", "circuit", "graph"]);
  expect(drawableKinds((pack) => pack === "pyodide")).toEqual(["plot"]);
  // The drawing pack without Python draws graphs, which run in the drawing window: schemdraw runs in the Python sandbox.
  expect(drawableKinds((pack) => pack === "drawing")).toEqual(["graph"]);
  expect(drawableKinds(() => false)).toEqual([]);
  expect(FIGURE_KINDS.graph).toMatchObject({ codeMax: 4000, timeoutMs: 5000, renderer: "window" });
  expect(FIGURE_KINDS.plot.renderer).toBe("python");
  expect(FIGURE_KINDS.circuit.renderer).toBe("python");
});

const automaton = 'digraph { rankdir=LR; node [shape=circle]; q0 -> q1 [label="a"]; q1 -> q2 [label="b"]; q2 -> q0 [label="c"] }';
/** A chain of n nodes: n - 1 edges. */
const chain = (n: number) => `digraph { ${Array.from({ length: n }, (_, i) => `n${i}`).join(" -> ")} }`;

describe("a graph's DOT text", () => {
  it("passes when it is one graph within the limits, and says which layout to draw with", () => {
    expect(figureProblem("graph", automaton)).toBeNull();
    expect(checkDot(automaton)).toEqual({ problem: null, layout: "dot", nodes: 3, edges: 3, body: automaton.indexOf("{") + 1 });
    for (const text of [
      "graph { a -- b -- c }",
      "strict digraph G { a -> b; b -> a }",
      "DIGRAPH { A -> B }",
      '// a comment\ndigraph { /* inline */ a -> b # not a comment\n }'.replace("# not a comment", ""),
      "digraph { a:p1:n -> b:s }",
      "digraph { subgraph cluster_0 { label=\"x\"; a; b } a -> b }",
      "digraph {\r\n  a -> b;\r\n  b -> c;\r\n}\r\n",
      "digraph { 1 -> 2; -3.5 -> .5 }",
      'digraph { "my node" -> "other" [label="a" + "b"] }',
      "digraph { a [shape=box fontname=\"Arial\", color=red] }",
      'digraph { node [fontname=Helvetica]; edge [labelfontname="helvetica"]; a -> b }',
    ])
      expect(figureProblem("graph", text), text).toBeNull();
    expect(checkDot("digraph { layout=neato; a -> b }")).toMatchObject({ layout: "neato" });
    expect(graphLayout("graph [layout=Circo]; digraph{}".replace("graph [layout=Circo]; ", ""))).toBe("dot");
    expect(graphLayout("digraph { graph [layout=circo]; a -> b }")).toBe("circo");
    expect(graphLayout("digraph { a -> ")).toBeNull();
  });

  it("counts a node once and an edge for each pair it joins", () => {
    expect(checkDot("digraph { a -> b; b -> a; a -> b }")).toMatchObject({ nodes: 2, edges: 3 });
    expect(checkDot("digraph { a -> {b c d} }")).toMatchObject({ nodes: 4, edges: 3 });
    expect(checkDot("digraph { {a b} -> {c d} -> e }")).toMatchObject({ nodes: 5, edges: 6 });
    // A node named in a subgraph is a node of the graph.
    expect(checkDot("digraph { subgraph s { a b } c -> a }")).toMatchObject({ nodes: 3, edges: 1 });
  });

  it("holds a graph to 150 nodes and 300 edges", () => {
    expect(figureProblem("graph", chain(DOT_NODES_MAX))).toBeNull();
    expect(figureProblem("graph", chain(DOT_NODES_MAX + 1))).toBe(`the graph has ${DOT_NODES_MAX + 1} nodes: keep it within ${DOT_NODES_MAX}`);
    // Few nodes, many edges: ten nodes each joined to the others.
    const dense = `digraph { ${Array.from({ length: 10 }, (_, i) => `n${i} -> {${Array.from({ length: 10 }, (_, j) => `n${j}`).join(" ")}}`).join("; ")} }`;
    expect(checkDot(dense)).toMatchObject({ nodes: 10, edges: 100 });
    const edges = (n: number) => `digraph { ${Array.from({ length: n }, () => "a -> b").join("; ")} }`;
    expect(figureProblem("graph", edges(DOT_EDGES_MAX))).toBeNull();
    expect(figureProblem("graph", edges(DOT_EDGES_MAX + 1))).toBe(`the graph has ${DOT_EDGES_MAX + 1} edges: keep it within ${DOT_EDGES_MAX}`);
    // A product that is too big is refused as it is counted, never expanded.
    const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
    expect(figureProblem("graph", `digraph { {${names("a", 20)}} -> {${names("b", 20)}} }`)).toBe(
      `the graph has 400 edges: keep it within ${DOT_EDGES_MAX}`,
    );
    // The size limit of every kind holds first.
    expect(figureProblem("graph", `digraph { a [label="${"x".repeat(4000)}"] }`)).toMatch(/keep it within 4000/);
  });

  it("refuses the attributes that reach for a file, a link or an element name, in every place and every spelling", () => {
    for (const attribute of [
      'image="/etc/passwd"',
      'image="C:\\Windows\\win.ini"',
      'imagepath="/etc"',
      'shapefile="/etc/passwd"',
      'fontpath="/usr/share/fonts"',
      'URL="https://example.com"',
      'url="https://example.com"',
      'href="https://example.com"',
      'HREF="x"',
      'labelURL="x"',
      'edgeURL="x"',
      'headhref="x"',
      'tailURL="x"',
      'stylesheet="x.css"',
      'id="x"',
      'target="_blank"',
      '"URL"="x"',
    ]) {
      const name = attribute.split("=")[0]!.replaceAll('"', "");
      const problem = `the attribute ${name} is not allowed: it reaches for a file, a link or an element name, so remove it`;
      for (const text of [
        `digraph { a [${attribute}] }`,
        `digraph { a -> b [${attribute}] }`,
        `digraph { node [${attribute}]; a }`,
        `digraph { edge [${attribute}]; a -> b }`,
        `digraph { graph [${attribute}]; a }`,
        `digraph { ${attribute}; a }`,
        `digraph { subgraph cluster_0 { a [${attribute}] } }`,
        `digraph { a [label="x", ${attribute}] }`,
        `digraph { a [color=red; ${attribute}] }`,
      ])
        expect(figureProblem("graph", text), text).toBe(problem);
    }
    // Other attributes are fine, and so is a quoted label that mentions one.
    expect(figureProblem("graph", 'digraph { a [label="image and URL" color=red tooltip="x"] }')).toBeNull();
  });

  it("refuses HTML-like labels wherever they are, and comments do not hide them", () => {
    const problem = "HTML-like labels (<...>) are not allowed: write the label as a quoted string";
    for (const text of [
      "digraph { a [label=<<b>x</b>>] }",
      'digraph { a [label=<<TABLE HREF="http://x"><TR><TD><IMG SRC="/etc/passwd"/></TD></TR></TABLE>>] }',
      "digraph { a -> <b> }",
      "digraph { a [label=<x] }",
    ])
      expect(figureProblem("graph", text), text).toBe(problem);
    // A < inside a quoted string or a comment is text.
    expect(figureProblem("graph", 'digraph { a [label="<b>x</b>"] /* <i> */ // <u>\n }')).toBeNull();
  });

  it("allows only the font names Graphviz has metrics for, in every place a font can be named", () => {
    for (const name of ["Arial", "arial", "Helvetica", "HELVETICA", '"Arial"'])
      for (const text of [`digraph { a [fontname=${name}] }`, `digraph { graph [fontname=${name}]; a }`, `digraph { a -> b [labelfontname=${name}] }`])
        expect(figureProblem("graph", text), text).toBeNull();
    for (const name of ["Times", "Figtree", "Courier", '"sans-serif"', '"../../fonts/x.ttf"', '"C:\\\\Windows\\\\Fonts\\\\x.ttf"', '"Arial, Helvetica"', "true"])
      for (const attribute of ["fontname", "labelfontname", "FONTNAME"])
        for (const text of [`digraph { a [${attribute}=${name}] }`, `digraph { graph [${attribute}=${name}]; a }`, `digraph { subgraph cluster_0 { ${attribute}=${name}; a } }`]) {
          const written = name.replaceAll('"', "");
          expect(figureProblem("graph", text), text).toBe(
            `${attribute}=${written} is not allowed: leave ${attribute} out, graphs are drawn in the app's own font`,
          );
        }
    // fontpath is refused with the other attributes that name a file, and a font name inside a label is only text.
    expect(figureProblem("graph", 'digraph { fontpath="/usr/share/fonts"; a }')).toMatch(/fontpath is not allowed/);
    expect(figureProblem("graph", 'digraph { a [label="fontname=Times"] }')).toBeNull();
  });

  it("puts the graph's default look first, so the text's own attributes win, and finds the brace in any text", () => {
    const styled = styledDot('strict digraph "a { b" { /* { */ q0 -> q1 [fontsize=20] }');
    expect(styled.startsWith('strict digraph "a { b" { ')).toBe(true);
    // The defaults come before the first statement, and the text's own statements after them.
    expect(styled.indexOf(DOT_DEFAULTS)).toBeLessThan(styled.indexOf("/* { */"));
    expect(styled.indexOf(DOT_DEFAULTS)).toBeLessThan(styled.indexOf("q0 -> q1 [fontsize=20]"));
    expect(styled.endsWith("q0 -> q1 [fontsize=20] }")).toBe(true);
    expect(checkDot(styled)).toMatchObject({ problem: null, nodes: 2, edges: 1 });
    // The defaults pass the checks themselves, set Arial metrics, the ink of the circuits and a size like a plot's.
    expect(checkDot(`digraph { ${DOT_DEFAULTS} }`)).toMatchObject({ problem: null, nodes: 0 });
    expect(DOT_DEFAULTS).toContain('fontname="Arial"');
    expect(DOT_DEFAULTS).toContain('color="#15181e"');
    expect(DOT_DEFAULTS).toContain('size="6.4,5"');
    expect(DOT_DEFAULTS).not.toContain("!");
    // A text the check cannot read still gets them after its first brace, and one with no brace gets none.
    expect(styledDot("digraph {a -> ")).toBe(`digraph { ${DOT_DEFAULTS} a -> `);
    expect(styledDot("not a graph")).toBe("not a graph");
    expect(styledDot("")).toBe("");
    // CRLF text is styled the same.
    expect(styledDot("digraph {\r\n a -> b\r\n}")).toBe(`digraph { ${DOT_DEFAULTS} \r\n a -> b\r\n}`);
  });

  it("allows only the five layout engines", () => {
    for (const layout of ["dot", "neato", "circo", "fdp", "twopi", "NEATO"])
      expect(figureProblem("graph", `digraph { layout=${layout}; a -> b }`), layout).toBeNull();
    for (const layout of ["sfdp", "osage", "patchwork", "nop", "nop2", "ortho", '"../../x"'])
      expect(figureProblem("graph", `digraph { layout=${layout}; a -> b }`), layout).toBe(
        `layout=${layout.replaceAll('"', "")} is not allowed: use one of dot, neato, circo, fdp, twopi`,
      );
    expect(figureProblem("graph", "digraph { node [layout=sfdp]; a }")).toMatch(/layout=sfdp is not allowed/);
  });

  it("refuses text that is not one DOT graph, with a message the model can act on", () => {
    expect(figureProblem("graph", "")).toMatch(/starts with "graph" or "digraph"/);
    expect(figureProblem("graph", "a -> b")).toMatch(/starts with "graph" or "digraph"/);
    expect(figureProblem("graph", "digraph { a -> b")).toMatch(/"\{" is never closed/);
    expect(figureProblem("graph", "digraph { a -> }")).toMatch(/expected a node name/);
    expect(figureProblem("graph", 'digraph { a [label="x] }')).toMatch(/string is never closed/);
    expect(figureProblem("graph", "digraph { a /* b }")).toMatch(/comment is never closed/);
    expect(figureProblem("graph", "digraph { a [color=red }")).toMatch(/"\[" is never closed|expected an attribute name/);
    expect(figureProblem("graph", "digraph { a } digraph { b }")).toMatch(/only one graph/);
    expect(figureProblem("graph", "digraph { a ? b }")).toMatch(/character "\?" is not valid/);
    expect(figureProblem("graph", "digraph { a -> b }\u0000")).toMatch(/not valid/);
  });
});
