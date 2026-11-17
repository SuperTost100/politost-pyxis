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

  it("reads names and values the way Graphviz's lexer joins them: a backslash and a newline inside a string, and strings joined by +", () => {
    // Graphviz drops a backslash that ends a line inside a quoted string and joins the two halves, so these name URL, image
    // and layout. Each of these was passed by the check, and each makes Graphviz write a link, read a file or change its engine.
    for (const [spelling, text] of Object.entries({
      "URL split by a continuation": 'digraph { a ["UR\\\nL"="https://example.com/x"] }',
      "image split by a continuation": 'digraph { a ["ima\\\nge"="/etc/passwd"] }',
      "href in a node default": 'digraph { node ["hr\\\nef"="x"]; a }',
      "URL joined by +": 'digraph { a ["UR" + "L"="https://example.com/c"] }',
      "URL joined by + across lines": 'digraph { a ["UR" +\n  "L"="x"] }',
      "URL joined by + around a comment": 'digraph { a ["UR" /* c */ + /* c */ "L"="x"] }',
      "a graph attribute joined by +": 'digraph { "ima" + "ge" = "x"; a }',
      "URL with a continuation and +": 'digraph { a ["U\\\nR" + "L"="x"] }',
      "URL in a keyword of another case": 'DiGraph { NODE [URL="x"]; a }',
      "URL in a subgraph keyword of another case": 'digraph { SubGraph s { Edge [URL="x"]; a -> b } }',
    }))
      expect(figureProblem("graph", text), spelling).toMatch(/^the attribute \S+ is not allowed: it reaches for a file, a link or an element name/);
    expect(figureProblem("graph", 'digraph { "lay\\\nout"=sfdp; a -> b }')).toBe("layout=sfdp is not allowed: use one of dot, neato, circo, fdp, twopi");
    expect(figureProblem("graph", 'digraph { layout="sf\\\ndp"; a -> b }')).toBe("layout=sfdp is not allowed: use one of dot, neato, circo, fdp, twopi");
    expect(figureProblem("graph", 'digraph { layout="sf" + "dp"; a -> b }')).toBe("layout=sfdp is not allowed: use one of dot, neato, circo, fdp, twopi");
    expect(figureProblem("graph", 'digraph { a [fontname="Tim" + "es"] }')).toMatch(/fontname=Times is not allowed/);
    expect(figureProblem("graph", 'digraph { a [fontname="Ti\\\nmes"] }')).toMatch(/fontname=Times is not allowed/);
    // Joined, a name that is not one of those is fine, and so is a node named like an attribute.
    expect(figureProblem("graph", 'digraph { a ["col" + "or"="red"]; "UR" + "L" -> b }')).toBeNull();
    // A backslash that does not end a line stays a character of the name, as in Graphviz, so it names nothing.
    expect(figureProblem("graph", 'digraph { a ["UR\\L"="x"] }')).toBeNull();
  });

  it("counts a subgraph that is named again as the nodes it already has, so no text makes more edges than it shows", () => {
    const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
    // The text the review found: 20 nodes named once, then the subgraph named again on both sides of an edge. Graphviz
    // makes 400 edges from it (checked against the pinned build) and the check said one.
    const reopened = `digraph { subgraph s { ${names("n", 20)} } subgraph s {} -> subgraph s {} }`;
    expect(checkDot(reopened)).toEqual({ problem: "the graph has 400 edges: keep it within 300" });
    // The same text at a size that passes, to show the count: 12 nodes, every pair.
    expect(checkDot(`digraph { subgraph s { ${names("n", 12)} } subgraph s {} -> subgraph s {} }`)).toMatchObject({ problem: null, nodes: 12, edges: 144 });
    expect(checkDot(`digraph { subgraph s { ${names("n", 12)} } subgraph s {} -> subgraph s {} -> subgraph s {} }`)).toMatchObject({ problem: null, edges: 288 });
    expect(checkDot(`digraph { subgraph cluster_x { ${names("n", 12)} } subgraph cluster_x {} -> subgraph cluster_x {} }`)).toMatchObject({ edges: 144 });
    expect(checkDot(`digraph { subgraph s { ${names("n", 20)} } a -> subgraph s {} }`)).toMatchObject({ nodes: 21, edges: 20 });
    // A subgraph that grows each time it is named: what it holds so far is what it stands for.
    expect(checkDot("digraph { subgraph s { a b } subgraph s { c } subgraph s {} -> x }")).toMatchObject({ nodes: 4, edges: 3 });
    // The names are the same when they are spelled differently.
    expect(checkDot(`digraph { subgraph "s" { ${names("n", 12)} } SUBGRAPH "s" {} -> subgraph "s" {} }`)).toMatchObject({ edges: 144 });
    expect(checkDot('digraph { subgraph "s" { a b c } subgraph "" {} -> subgraph s {} }')).toMatchObject({ nodes: 3, edges: 3 });
    // Nested, and through a subgraph that holds another one.
    expect(checkDot("digraph { subgraph s { subgraph t { a b c } } subgraph t {} -> subgraph s {} }")).toMatchObject({ nodes: 3, edges: 9 });
    // Refused over the limit however it is reached.
    // Counted as it is read, so a text that would make millions of edges is refused at the first pair over the limit.
    expect(figureProblem("graph", `digraph { subgraph s { ${names("n", 20)} } subgraph s {} -> subgraph s {} -> subgraph s {} -> subgraph s {} }`)).toBe(
      `the graph has 400 edges: keep it within ${DOT_EDGES_MAX}`,
    );
    expect(figureProblem("graph", `digraph { subgraph s { ${names("n", 150)} } ${Array.from({ length: 10 }, () => "subgraph s {}").join(" -> ")} }`)).toMatch(/edges: keep it within 300/);
    // An edge in a subgraph that is named again is not made again: only the text that is written is run.
    expect(checkDot("digraph { subgraph s { a -> b } subgraph s { c } subgraph s { } }")).toMatchObject({ nodes: 3, edges: 1 });
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

  it("refuses the knobs that only make a layout slow, and a charset that is not UTF-8", () => {
    for (const knob of ["mclimit", "nslimit", "nslimit1", "searchsize", "maxiter", "epsilon", "Damping", "K", "MCLIMIT"])
      for (const text of [`digraph { ${knob}=1000000; a -> b }`, `digraph { graph [${knob}=1000000]; a }`, `digraph { subgraph s { ${knob}=9; a } }`])
        expect(figureProblem("graph", text), text).toBe(`the attribute ${knob} is not allowed: it only tunes how long the layout takes, so remove it`);
    // A node named like one is a node.
    expect(figureProblem("graph", "digraph { K -> maxiter -> epsilon }")).toBeNull();
    for (const text of ['digraph { charset="latin1"; a }', "digraph { charset=big5; a }"])
      expect(figureProblem("graph", text), text).toMatch(/^charset=.* is not allowed: the text is UTF-8$/);
    for (const text of ['digraph { charset="UTF-8"; a }', "digraph { charset=utf8; a }"]) expect(figureProblem("graph", text), text).toBeNull();
  });

  it("allows only the five layout engines", () => {
    for (const layout of ["dot", "neato", "circo", "fdp", "twopi"])
      expect(figureProblem("graph", `digraph { layout=${layout}; a -> b }`), layout).toBeNull();
    // Graphviz reads the value exactly, so a spelling it would not find is refused, whatever the check once folded.
    for (const layout of ["NEATO", "Neato", '" neato"', '"neato "'])
      expect(figureProblem("graph", `digraph { layout=${layout}; a -> b }`), layout).toBe(
        `layout=${layout.replaceAll('"', "")} is not allowed: use one of dot, neato, circo, fdp, twopi, in lower case with no spaces`,
      );
    for (const layout of ["sfdp", "osage", "patchwork", "nop", "nop2", "ortho", '"../../x"'])
      expect(figureProblem("graph", `digraph { layout=${layout}; a -> b }`), layout).toBe(
        `layout=${layout.replaceAll('"', "")} is not allowed: use one of dot, neato, circo, fdp, twopi`,
      );
    expect(figureProblem("graph", "digraph { node [layout=sfdp]; a }")).toMatch(/layout=sfdp is not allowed/);
  });

  it("reads every attribute list of a default statement, and checks each one", () => {
    // `node [a][b]` is two lists, as it is after a node or an edge.
    for (const text of [
      "digraph { node [shape=box][fontsize=11]; a -> b }",
      "digraph { edge [color=red][style=dashed]; a -> b }",
      "digraph { graph [rankdir=LR][nodesep=1]; a -> b }",
      "digraph { node [shape=box] [fontsize=11] [color=blue]; a }",
    ])
      expect(checkDot(text), text).toMatchObject({ problem: null });
    // Every list gets the same checks as the first: the second cannot carry what the first could not.
    expect(figureProblem("graph", 'digraph { node [shape=box][URL="x"]; a }')).toMatch(/the attribute URL is not allowed/);
    expect(figureProblem("graph", 'digraph { node [shape=box][fontname="Times"]; a }')).toMatch(/fontname=Times is not allowed/);
    expect(figureProblem("graph", "digraph { node [shape=box][layout=sfdp]; a }")).toMatch(/layout=sfdp is not allowed/);
    expect(figureProblem("graph", "digraph { node [shape=box][mclimit=9]; a }")).toMatch(/the attribute mclimit is not allowed/);
    expect(figureProblem("graph", "digraph { node [shape=box][fontsize=11; a }")).toMatch(/expected an attribute name inside/);
    // Only lists: a name after the first one is a statement of its own, and a default still needs its bracket.
    expect(figureProblem("graph", "digraph { node [shape=box] fontsize; a }")).toBeNull();
    expect(figureProblem("graph", "digraph { node shape=box; a }")).toMatch(/expected "\[" after a graph, node or edge default/);
  });

  it("counts the edges of a strict graph once for each pair of nodes, and holds every other graph to the same count as before", () => {
    const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
    // 18 nodes joined to themselves: 324 pairs written, 171 different edges in a strict graph (loops included).
    const all = `{${names("n", 18)}} -- {${names("n", 18)}}`;
    expect(checkDot(`strict graph { ${all} }`)).toMatchObject({ problem: null, nodes: 18, edges: 171 });
    expect(checkDot(`STRICT Graph { ${all} }`)).toMatchObject({ problem: null, edges: 171 });
    expect(checkDot(`graph { ${all} }`)).toEqual({ problem: `the graph has 324 edges: keep it within ${DOT_EDGES_MAX}` });
    // A directed strict graph has an edge for each ordered pair: all 324 of them are different.
    expect(checkDot(`strict digraph { {${names("n", 18)}} -> {${names("n", 18)}} }`)).toEqual({
      problem: `the graph has 324 edges: keep it within ${DOT_EDGES_MAX}`,
    });
    // The same edge written again, and the same pair the other way round, is one edge of a strict graph and several of another.
    expect(checkDot("strict graph { a -- b; b -- a; a -- b }")).toMatchObject({ nodes: 2, edges: 1 });
    expect(checkDot("graph { a -- b; b -- a; a -- b }")).toMatchObject({ edges: 3 });
    expect(checkDot("strict digraph { a -> b; b -> a; a -> b }")).toMatchObject({ edges: 2 });
    expect(checkDot("digraph { a -> b; b -> a; a -> b }")).toMatchObject({ edges: 3 });
    const again = (n: number) => `${Array.from({ length: n }, () => "a -- b").join("; ")}`;
    expect(checkDot(`strict graph { ${again(DOT_EDGES_MAX + 50)} }`)).toMatchObject({ problem: null, edges: 1 });
    expect(checkDot(`graph { ${again(DOT_EDGES_MAX + 1)} }`)).toEqual({ problem: `the graph has ${DOT_EDGES_MAX + 1} edges: keep it within ${DOT_EDGES_MAX}` });
    // Different pairs are all counted: 20 by 20 names is 400 of them, strict or not.
    expect(checkDot(`strict graph { {${names("a", 20)}} -- {${names("b", 20)}} }`)).toEqual({
      problem: `the graph has 400 edges: keep it within ${DOT_EDGES_MAX}`,
    });
    // An edge with a `key` is a new edge of a strict graph when its pair is the other way round, so with a key anywhere in
    // an undirected strict graph the two orders of a pair are counted apart (Graphviz builds 392 edges from this text).
    const keyed = `strict graph { {${names("a", 14)}} -- {${names("b", 14)}}; {${names("b", 14)}} -- {${names("a", 14)}} [key=k] }`;
    expect(checkDot(keyed)).toEqual({ problem: `the graph has 392 edges: keep it within ${DOT_EDGES_MAX}` });
    expect(checkDot(keyed.replace(" [key=k]", ""))).toMatchObject({ problem: null, nodes: 28, edges: 196 });
    // Wherever the key is, whatever its case, and whichever edges it names.
    expect(checkDot(`strict graph { edge [KEY=k]; {${names("a", 14)}} -- {${names("b", 14)}}; {${names("b", 14)}} -- {${names("a", 14)}} }`)).toEqual({
      problem: `the graph has 392 edges: keep it within ${DOT_EDGES_MAX}`,
    });
    expect(checkDot("strict graph { a -- b; b -- a [key=k] }")).toMatchObject({ problem: null, edges: 2 });
    expect(checkDot("strict graph { a -- b; b -- a }")).toMatchObject({ problem: null, edges: 1 });
    // A subgraph named again stands for what it holds, and a subgraph with nothing in it is counted as one node each time.
    expect(checkDot(`strict graph { subgraph s { ${names("n", 18)} } subgraph s {} -- subgraph s {} }`)).toMatchObject({ edges: 171 });
    expect(checkDot(`strict graph { ${Array.from({ length: DOT_EDGES_MAX + 1 }, () => "subgraph {} -- subgraph {}").join("; ")} }`)).toEqual({
      problem: `the graph has ${DOT_EDGES_MAX + 1} edges: keep it within ${DOT_EDGES_MAX}`,
    });
  });

  it("selects the engine from the graph's own layout, and checks the attribute wherever it is written", () => {
    // `layout` is an attribute of the graph. On a node, an edge or a subgraph it is another thing, and it selects nothing.
    for (const text of [
      "digraph { node [layout=neato]; a -> b -> c }",
      "digraph { edge [layout=circo]; a -> b }",
      "digraph { a [layout=fdp]; a -> b }",
      "digraph { a -> b [layout=twopi] }",
    ])
      expect(checkDot(text), text).toMatchObject({ problem: null, layout: "dot" });
    // Where only a subgraph sets a layout, Graphviz cannot draw the graph at all (it says the layout was not done,
    // whichever engine it is given), so the check says where `layout` goes. Where the root sets one too, the graph is
    // drawn, with the root's engine, wherever the root sets it.
    for (const text of [
      "digraph { subgraph s { layout=twopi; a -> b } }",
      "digraph { subgraph s { graph [layout=fdp]; a -> b } }",
      "digraph { {layout=neato; a} -> b }",
      "digraph { subgraph cluster_c { layout=circo; a -> b } subgraph s { layout=neato; c } }",
    ])
      expect(checkDot(text), text).toEqual({
        problem: expect.stringMatching(/^layout=\w+ is set inside a subgraph, where Graphviz cannot draw it: set the layout on the graph itself/),
      });
    expect(checkDot("digraph { subgraph s { layout=twopi; a -> b } }")).toEqual({
      problem: "layout=twopi is set inside a subgraph, where Graphviz cannot draw it: set the layout on the graph itself, at its top level (digraph { layout=twopi; ... })",
    });
    for (const [text, layout] of [
      ["digraph { layout=neato; subgraph cluster_c { layout=circo; a -> b } }", "neato"],
      ["digraph { subgraph cluster_c { layout=circo; a -> b } layout=neato }", "neato"],
      ["digraph { graph [layout=neato]; subgraph cluster_c { layout=circo; a -> b } }", "neato"],
      ["digraph { layout=dot; subgraph cluster_c { layout=neato; a -> b } }", "dot"],
      ["digraph { layout=twopi; subgraph s { graph [layout=fdp]; a } {layout=circo; b} -> c }", "twopi"],
    ] as const)
      expect(checkDot(text), text).toMatchObject({ problem: null, layout });
    // A value Graphviz would not take is refused wherever it is written, whether or not the root sets a layout.
    for (const text of [
      "digraph { subgraph s { layout=sfdp; a } }",
      "digraph { layout=neato; subgraph s { layout=sfdp; a } }",
      "digraph { subgraph s { layout=NEATO; a } layout=neato }",
      "digraph { layout=neato; subgraph s { graph [layout=osage]; a } }",
    ])
      expect(figureProblem("graph", text), text).toMatch(/layout=.* is not allowed: use one of/);
    for (const [text, layout] of [
      ["digraph { layout=neato; a -> b }", "neato"],
      ["digraph { graph [layout=circo]; a -> b }", "circo"],
      ["digraph { graph [fontsize=9][layout=fdp]; a -> b }", "fdp"],
      ["digraph { subgraph s { label=x; a } layout=neato; a -> b }", "neato"],
    ] as const)
      expect(checkDot(text), text).toMatchObject({ problem: null, layout });
    // A subgraph's own graph attributes other than the layout are as they were.
    expect(checkDot("digraph { subgraph cluster_c { label=x; graph [color=red]; a } }")).toMatchObject({ problem: null, layout: "dot" });
    // A spelling Graphviz would not find, or an engine this app does not draw with, is refused in every place.
    for (const text of [
      "digraph { node [layout=sfdp]; a }",
      "digraph { a [layout=NEATO] }",
      "digraph { edge [layout=osage]; a -> b }",
      "digraph { subgraph s { layout=ortho; a } }",
      'digraph { a -> b [layout="../x"] }',
    ])
      expect(figureProblem("graph", text), text).toMatch(/layout=.* is not allowed: use one of/);
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
