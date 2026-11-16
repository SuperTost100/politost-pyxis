/**
 * The checks a Graphviz DOT text must pass before anything draws it. The text comes from an AI or from an imported plan
 * file, so it is read here as untrusted: a light tokeniser and a statement walker count its nodes and edges and look at
 * every attribute name, without ever running Graphviz. Core checks a block with this before it asks for a drawing, and
 * main checks again before the drawing window sees the text.
 */

export const DOT_NODES_MAX = 150;
export const DOT_EDGES_MAX = 300;
/** The layout engines a graph may ask for with its `layout` attribute. */
export const DOT_LAYOUTS = ["dot", "neato", "circo", "fdp", "twopi"] as const;
export type DotLayout = (typeof DOT_LAYOUTS)[number];

/**
 * Attributes whose values name a file, a link or an element id: Graphviz would read the file, write the link into the
 * drawing or give an element a name the page can find. Compared in lower case. Every name that ends in `url` or `href`
 * (URL, labelURL, headhref and the rest) is refused too.
 */
/** The font names a graph may give: the ones Graphviz has metrics for, drawn in the app's font all the same. */
const FONT_NAMES = ["arial", "helvetica"];
const REFUSED = new Set(["image", "imagepath", "shapefile", "fontpath", "stylesheet", "id", "target"]);

/** `at` is where the token starts in the text. */
type Token =
  | { kind: "id"; value: string; at: number }
  | { kind: "string"; value: string; at: number }
  | { kind: "edgeop"; at: number }
  | { kind: "punct"; value: string; at: number };

type Lexed = { tokens: Token[]; problem: null } | { tokens: null; problem: string };

const ID_START = /[A-Za-z_\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_\u0080-￿]/;

function lex(code: string): Lexed {
  const tokens: Token[] = [];
  let i = 0;
  let lineStart = true;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "\n") {
      lineStart = true;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    // A line that starts with # is a preprocessor line, which Graphviz ignores.
    if (c === "#" && lineStart) {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    lineStart = false;
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end < 0) return { tokens: null, problem: "a /* comment is never closed" };
      i = end + 2;
      continue;
    }
    if (c === '"') {
      const start = i;
      let value = "";
      i++;
      for (;;) {
        if (i >= code.length) return { tokens: null, problem: 'a string is never closed: close it with a "' };
        const d = code[i]!;
        if (d === "\\" && i + 1 < code.length) {
          // An escaped quote stays in the string; every other escape is for Graphviz to read.
          value += code[i + 1] === '"' ? '"' : d + code[i + 1];
          i += 2;
          continue;
        }
        if (d === '"') break;
        value += d;
        i++;
      }
      i++;
      tokens.push({ kind: "string", value, at: start });
      continue;
    }
    // An HTML-like label, <...>, can hold tables, links and images. None is needed to draw a graph, so none is read.
    if (c === "<")
      return {
        tokens: null,
        problem: "HTML-like labels (<...>) are not allowed: write the label as a quoted string",
      };
    if ((c === "-" && code[i + 1] === ">") || (c === "-" && code[i + 1] === "-")) {
      tokens.push({ kind: "edgeop", at: i });
      i += 2;
      continue;
    }
    if ("{}[];,=:+".includes(c)) {
      tokens.push({ kind: "punct", value: c, at: i });
      i++;
      continue;
    }
    const number = /^-?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)/.exec(code.slice(i, i + 64));
    if (number) {
      tokens.push({ kind: "id", value: number[0], at: i });
      i += number[0].length;
      continue;
    }
    if (ID_START.test(c)) {
      let end = i + 1;
      while (end < code.length && ID_PART.test(code[end]!)) end++;
      tokens.push({ kind: "id", value: code.slice(i, end), at: i });
      i = end;
      continue;
    }
    return { tokens: null, problem: `the character ${JSON.stringify(c)} is not valid in DOT` };
  }
  return { tokens, problem: null };
}

class Stop extends Error {}

/** Reads the token list as a DOT graph: the first problem it finds stops the walk. */
class Walker {
  private at = 0;
  readonly nodes = new Set<string>();
  edges = 0;
  layout: DotLayout | null = null;
  /** Where the graph's body starts: just after its opening brace. */
  body = 0;

  constructor(private readonly tokens: Token[]) {}

  private fail(message: string): never {
    throw new Stop(message);
  }
  private peek(): Token | undefined {
    return this.tokens[this.at];
  }
  private next(): Token | undefined {
    return this.tokens[this.at++];
  }
  private isPunct(value: string): boolean {
    const token = this.peek();
    return token?.kind === "punct" && token.value === value;
  }
  private isKeyword(...words: string[]): boolean {
    const token = this.peek();
    return token?.kind === "id" && words.includes(token.value.toLowerCase());
  }
  private expect(value: string): void {
    if (!this.isPunct(value)) this.fail(`expected "${value}" in the DOT text`);
    this.at++;
  }

  graph(): void {
    if (this.isKeyword("strict")) this.at++;
    if (!this.isKeyword("graph", "digraph")) this.fail('a DOT text starts with "graph" or "digraph"');
    this.at++;
    const name = this.peek();
    if (name && (name.kind === "id" || name.kind === "string")) this.at++;
    const brace = this.peek();
    this.expect("{");
    this.body = brace!.at + 1;
    this.statements();
    if (this.peek()) this.fail("only one graph is allowed: remove what follows its closing }");
  }

  /** The statements up to the } that closes the block, which it reads. Returns the nodes the block named. */
  private statements(): Set<string> {
    const named = new Set<string>();
    for (;;) {
      const token = this.peek();
      if (!token) this.fail('a "{" is never closed');
      if (token.kind === "punct" && token.value === "}") {
        this.at++;
        return named;
      }
      if (token.kind === "punct" && token.value === ";") {
        this.at++;
        continue;
      }
      this.statement(named);
    }
  }

  private statement(named: Set<string>): void {
    if (this.isKeyword("graph", "node", "edge")) {
      this.at++;
      if (!this.isPunct("[")) this.fail('expected "[" after a graph, node or edge default');
      this.attributes();
      return;
    }
    const first = this.peek()!;
    // `name = value` sets a graph attribute.
    const second = this.tokens[this.at + 1];
    if ((first.kind === "id" || first.kind === "string") && second?.kind === "punct" && second.value === "=") {
      this.at += 2;
      this.attribute(first.value, this.value());
      return;
    }
    let previous = this.operand(named);
    while (this.peek()?.kind === "edgeop") {
      this.at++;
      const following = this.operand(named);
      this.edges += previous * following;
      if (this.edges > DOT_EDGES_MAX) this.tooMany("edges", this.edges, DOT_EDGES_MAX);
      previous = following;
    }
    while (this.isPunct("[")) this.attributes();
  }

  /** A node (with its port) or a subgraph. Returns how many nodes it stands for. */
  private operand(named: Set<string>): number {
    if (this.isKeyword("subgraph") || this.isPunct("{")) {
      if (this.isKeyword("subgraph")) {
        this.at++;
        const name = this.peek();
        if (name && (name.kind === "id" || name.kind === "string")) this.at++;
        // A subgraph named but not opened refers to one written elsewhere: one node is the least it can be.
        if (!this.isPunct("{")) return 1;
      }
      this.expect("{");
      const inside = this.statements();
      for (const node of inside) named.add(node);
      return Math.max(1, inside.size);
    }
    const token = this.next();
    if (!token || (token.kind !== "id" && token.kind !== "string"))
      this.fail("expected a node name, a subgraph or an attribute in the DOT text");
    this.node(token.value, named);
    // A port: node:port or node:port:compass.
    for (let parts = 0; parts < 2 && this.isPunct(":"); parts++) {
      this.at++;
      const port = this.next();
      if (!port || (port.kind !== "id" && port.kind !== "string")) this.fail('expected a port name after ":"');
    }
    return 1;
  }

  private node(name: string, named: Set<string>): void {
    named.add(name);
    this.nodes.add(name);
    if (this.nodes.size > DOT_NODES_MAX) this.tooMany("nodes", this.nodes.size, DOT_NODES_MAX);
  }

  private tooMany(what: string, count: number, max: number): never {
    this.fail(`the graph has ${count} ${what}: keep it within ${max}`);
  }

  /** A value: an ID or a quoted string, with quoted strings joined by +. */
  private value(): string {
    const token = this.next();
    if (!token || (token.kind !== "id" && token.kind !== "string")) this.fail('expected a value after "="');
    let value = token.value;
    while (token.kind === "string" && this.isPunct("+")) {
      this.at++;
      const more = this.next();
      if (!more || more.kind !== "string") this.fail('expected a quoted string after "+"');
      value += more.value;
    }
    return value;
  }

  /** `[a=b, c=d; e]`, read from the opening bracket. */
  private attributes(): void {
    this.expect("[");
    for (;;) {
      const token = this.next();
      if (!token) this.fail('a "[" is never closed');
      if (token.kind === "punct" && token.value === "]") return;
      if (token.kind === "punct" && (token.value === ";" || token.value === ",")) continue;
      if (token.kind !== "id" && token.kind !== "string") this.fail("expected an attribute name inside [ ]");
      if (this.isPunct("=")) {
        this.at++;
        this.attribute(token.value, this.value());
      } else this.attribute(token.value, "true");
    }
  }

  private attribute(name: string, value: string): void {
    const key = name.toLowerCase();
    if (REFUSED.has(key) || key.endsWith("url") || key.endsWith("href"))
      this.fail(
        `the attribute ${name} is not allowed: it reaches for a file, a link or an element name, so remove it`,
      );
    // Graphs are drawn in the app's own font, which Graphviz sizes by the metrics of Arial and Helvetica. Any other name
    // would be measured as Times and look up a font on the machine, so no other name is taken.
    if (key.endsWith("fontname") && !FONT_NAMES.includes(value.trim().toLowerCase()))
      this.fail(`${name}=${value} is not allowed: leave ${name} out, graphs are drawn in the app's own font`);
    if (key === "layout") {
      const layout = value.trim().toLowerCase();
      if (!(DOT_LAYOUTS as readonly string[]).includes(layout))
        this.fail(`layout=${value} is not allowed: use one of ${DOT_LAYOUTS.join(", ")}`);
      this.layout = layout as DotLayout;
    }
  }
}

export type DotCheck =
  | { problem: string }
  | { problem: null; layout: DotLayout; nodes: number; edges: number; body: number };

/**
 * Whether a DOT text may be drawn, in words for the model that wrote it. It passes when it is one graph of at most
 * 150 nodes and 300 edges (an edge counted for each pair of nodes it joins, so `a -> {b c}` is two) with no HTML-like
 * label and none of the attributes that reach for files, links or element names, and with a `layout` that is one of
 * the five engines. `layout` is the engine to draw with.
 */
export function checkDot(code: string): DotCheck {
  const lexed = lex(code);
  if (lexed.problem !== null) return { problem: lexed.problem };
  const walker = new Walker(lexed.tokens);
  try {
    walker.graph();
  } catch (error) {
    if (error instanceof Stop) return { problem: error.message };
    throw error;
  }
  return {
    problem: null,
    layout: walker.layout ?? "dot",
    nodes: walker.nodes.size,
    edges: walker.edges,
    body: walker.body,
  };
}

/**
 * What a graph looks like unless it says otherwise, to sit on the same white card as a plot and a circuit: the ink of
 * the circuits, thin lines, small arrowheads, the plots' 11 point text, and a drawing no bigger than a plot (6.4 inches
 * across; a smaller graph is not enlarged). Text is measured as Arial, which Figtree, the font it is drawn in, matches
 * within a few percent, so labels fit their nodes. The statements come first in the graph, so every attribute the text
 * sets afterwards wins.
 */
export const DOT_DEFAULTS =
  'graph [fontname="Arial" fontsize=11 fontcolor="#15181e" size="6.4,5" pad=0.2 nodesep=0.35 ranksep=0.45]; ' +
  'node [fontname="Arial" fontsize=11 fontcolor="#15181e" color="#15181e" penwidth=1.2 margin="0.14,0.07"]; ' +
  'edge [fontname="Arial" fontsize=10 fontcolor="#15181e" color="#15181e" penwidth=1.2 arrowsize=0.7];';

/**
 * The text to give Graphviz: the graph with its defaults put first. A text the check cannot read (a test that skips the
 * check) gets them after its first brace, and one with no brace gets none.
 */
export function styledDot(code: string): string {
  const check = checkDot(code);
  const at = check.problem === null ? check.body : code.indexOf("{") + 1;
  return at > 0 ? `${code.slice(0, at)} ${DOT_DEFAULTS} ${code.slice(at)}` : code;
}
