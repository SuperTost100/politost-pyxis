import { DOT_EDGES_MAX, DOT_NODES_MAX, checkDotAttributes, describeGraphvizError } from "../shared/dot";

/** The part of a parsed Graphviz graph that is read: its counts, its own writing of itself, and its release. */
export type ParsedGraph = { nodeCount(): number; edgeCount(): number; toDot(): string; delete(): void };
export type GraphvizLibrary = {
  read(dot: string): ParsedGraph;
  layout(dot: string, format: "svg", engine: string): string;
  /** Parses and writes the graph out again, with no layout. Its error is the one that has the line. */
  nop(dot: string): string;
};

/**
 * What Graphviz understood of a DOT text, checked before it draws anything: the problem, or null. The text checks in
 * `dot.ts` read the text as Graphviz's lexer does, and this does not rely on them being right. Graphviz parses the text
 * (which is cheap beside the layout), and then its own counts of nodes and edges, however the text made them, are held to
 * the limits, and the text it writes back out is read for the attributes that reach for files, links and element names,
 * the layout and the font names, as the checks read any text. A name joined from two strings, a subgraph named again and
 * a spelling nobody thought of are all in that text as Graphviz took them. A text this refuses reaches no layout.
 */
export function inspectDot(library: GraphvizLibrary, code: string): string | null {
  let graph: ParsedGraph;
  try {
    graph = library.read(code);
  } catch {
    // `read` throws only that the text is not DOT. `nop` parses it again with no layout and throws the message with the
    // line, which is cut down to what the model needs (see `describeGraphvizError`).
    try {
      library.nop(code);
    } catch (error) {
      return describeGraphvizError(error instanceof Error ? error.message : String(error));
    }
    return "syntax error: Graphviz cannot read the DOT text";
  }
  try {
    const nodes = graph.nodeCount();
    if (nodes > DOT_NODES_MAX) return `the graph has ${nodes} nodes: keep it within ${DOT_NODES_MAX}`;
    const edges = graph.edgeCount();
    if (edges > DOT_EDGES_MAX) return `the graph has ${edges} edges: keep it within ${DOT_EDGES_MAX}`;
    return checkDotAttributes(graph.toDot());
  } finally {
    graph.delete();
  }
}
