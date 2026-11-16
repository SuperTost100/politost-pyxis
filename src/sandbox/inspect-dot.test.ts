import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { checkDot, styledDot } from "../shared/dot";
import { inspectDot, type GraphvizLibrary } from "./inspect-dot";

// Runs the real Graphviz of the drawing pack (the pinned file in .tmp/drawing) on texts that were written to get past the
// text checks, to show that what Graphviz itself understood is held to the limits and the rules, whatever the checks said.
const file = join(process.cwd(), ".tmp/drawing/graphviz.js");
const available = existsSync(file);
let library: GraphvizLibrary;

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const URL_PROBLEM = /^the attribute \S+ is not allowed: it reaches for a file, a link or an element name/;

describe.skipIf(!available)("what Graphviz understood of a DOT text", () => {
  beforeAll(async () => {
    const module = (await import(pathToFileURL(file).href)) as { Graphviz: { load: () => Promise<GraphvizLibrary> } };
    library = await module.Graphviz.load();
  });

  it("lets through the graphs that are fine, the defaults of the look included", () => {
    for (const text of [
      'digraph { rankdir=LR; node [shape=circle]; q0 -> q1 [label="a"]; q1 -> q0 [label="b"] }',
      "graph { a -- b -- c; b -- d }",
      'digraph { subgraph cluster_0 { label="Sistema"; a -> b } b -> c [label="à è ì ò ù"] }',
      "digraph { a:p1:n -> b:s; {a b} -> {c d} }",
      'digraph { a [fontname="Helvetica"]; node [fontname=Arial]; edge [labelfontname="arial"] }',
      "digraph { layout=neato; a -> b -> c -> a }",
    ])
      expect(inspectDot(library, styledDot(text)), text).toBeNull();
  });

  it("refuses what the text spelled in ways the checks were fooled by, because it reads Graphviz's own writing of it", () => {
    for (const [spelling, text, check] of [
      ["URL split by a continuation", 'digraph { a ["UR\\\nL"="https://example.com/x"] }', URL_PROBLEM],
      ["image split by a continuation", 'digraph { a ["ima\\\nge"="/etc/passwd"] }', URL_PROBLEM],
      ["imagepath, stylesheet and fontpath split", 'digraph { "image\\\npath"="/"; "style\\\nsheet"="x.css"; "font\\\npath"="/"; a }', URL_PROBLEM],
      ["URL joined by +", 'digraph { a ["UR" + "L"="https://example.com/c"] }', URL_PROBLEM],
      ["an edge default joined", 'digraph { edge ["head" + "href"="x"]; a -> b }', URL_PROBLEM],
      ["a subgraph's attribute joined", 'digraph { subgraph cluster_0 { "labelU" + "RL"="x"; a } }', URL_PROBLEM],
      ["a node default in another case", 'DiGraph { NODE [URL="x"]; a }', URL_PROBLEM],
      ["layout name split", 'digraph { "lay\\\nout"=sfdp; a -> b }', /^layout=sfdp is not allowed/],
      ["layout value split", 'digraph { layout="sf\\\ndp"; a -> b }', /^layout=sfdp is not allowed/],
      ["layout value joined", 'digraph { layout="pat" + "chwork"; a -> b }', /^layout=patchwork is not allowed/],
      ["layout in a subgraph", "digraph { subgraph s { layout=osage; a } }", /^layout=osage is not allowed/],
      ["fontname joined", 'digraph { a [fontname="Tim" + "es"] }', /^fontname=Times is not allowed/],
      ["a font name that is a path", 'digraph { node [fontname="/usr/share/fonts/x.ttf"]; a }', /^fontname=.*is not allowed/],
      ["an HTML-like label", 'digraph { a [label=<<TABLE HREF="http://x"><TR><TD><IMG SRC="/etc/passwd"/></TD></TR></TABLE>>] }', /HTML-like labels/],
      ["a tuning knob joined", 'digraph { "mc" + "limit"=1000000; a -> b }', /only tunes how long the layout takes/],
    ] as const) {
      expect(inspectDot(library, styledDot(text)), spelling).toMatch(check);
    }
  });

  it("holds the counts Graphviz made to the limits, whatever the text shows", () => {
    // The text the review found: one edge in the text, 400 edges in the graph.
    const reopened = `digraph { subgraph s { ${names("n", 20)} } subgraph s {} -> subgraph s {} }`;
    expect(checkDot(reopened).problem).toBe("the graph has 400 edges: keep it within 300");
    expect(inspectDot(library, reopened)).toBe("the graph has 400 edges: keep it within 300");
    expect(inspectDot(library, `digraph { subgraph s { ${names("n", 20)} } subgraph s {} -> subgraph s {} -> subgraph s {} }`)).toBe(
      "the graph has 800 edges: keep it within 300",
    );
    expect(inspectDot(library, `digraph { subgraph cluster_x { ${names("n", 20)} } subgraph cluster_x {} -> subgraph cluster_x {} }`)).toMatch(/400 edges/);
    // Every pair of two groups, and a group named once and then used on both sides of a chain.
    expect(inspectDot(library, `digraph { {${names("a", 20)}} -> {${names("b", 20)}} }`)).toBe("the graph has 400 edges: keep it within 300");
    // The most the 4,000 characters allow: 150 nodes joined to themselves ten times over, 202,500 edges, read in well under a
    // second and refused before any layout.
    const started = Date.now();
    const chain = `digraph { subgraph s { ${names("n", 150)} } ${Array.from({ length: 10 }, () => "subgraph s {}").join(" -> ")} }`;
    expect(chain.length).toBeLessThan(4000);
    expect(inspectDot(library, chain)).toBe("the graph has 202500 edges: keep it within 300");
    expect(Date.now() - started).toBeLessThan(3000);
    // Nodes, and parallel edges.
    expect(inspectDot(library, `digraph { ${names("n", 151)} }`)).toBe("the graph has 151 nodes: keep it within 150");
    expect(inspectDot(library, `digraph { ${Array.from({ length: 301 }, () => "a -> b").join("; ")} }`)).toBe("the graph has 301 edges: keep it within 300");
    // At the limits, it passes.
    expect(inspectDot(library, `digraph { ${Array.from({ length: 300 }, () => "a -> b").join("; ")} }`)).toBeNull();
    expect(inspectDot(library, `digraph { ${names("n", 150)} }`)).toBeNull();
  });

  it("says what Graphviz said when it cannot read the text", () => {
    expect(inspectDot(library, "digraph { a -> ")).toBe("syntax error: Graphviz cannot read the DOT text");
    expect(inspectDot(library, "not a graph")).toMatch(/\S/);
    expect(inspectDot(library, "")).toMatch(/\S/);
  });

  it("agrees with the text checks: whatever they let through, Graphviz's own reading either passes or fails for a reason of its own", () => {
    // A corpus of the tricky texts, each through both. A text the checks pass that Graphviz's reading refuses is a bypass of the
    // checks that this layer caught (and is listed, so it is known); a text they refuse is not tested here.
    const corpus = [
      "digraph { a -> b }",
      'digraph { a [label="x" + "y"] }',
      'digraph { "a" + "b" -> c }',
      "digraph { a -> b -> c; {a b} -> {c d} }",
      'digraph { # a [URL="x"]\n a }',
      'digraph {\n   # a [URL="x"]\n a }',
      'digraph { a [label="URL=x"] }',
      'digraph { a [tooltip="image"]; image -> URL }',
      'digraph { "UR\\L" -> b }',
      'digraph { a ["UR\\\r\nL"="x"] }',
      'digraph { a ["ＵＲＬ"="x"] }',
      'digraph { charset=latin1; a ["ÚRL"="x"] }',
      'digraph { /* "URL"="x" */ a }',
      'digraph { a [label="/* not a comment */ // nor this"] }',
    ];
    for (const text of corpus) {
      const checked = checkDot(text).problem;
      const inspected = inspectDot(library, styledDot(text));
      if (checked === null) expect(inspected === null || URL_PROBLEM.test(inspected) || /syntax error/.test(inspected), text).toBe(true);
    }
  });
});
