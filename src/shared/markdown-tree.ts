import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * The tree the renderer's own parser makes of a Markdown text: remark-parse with GFM and remark-math, the plugins
 * `MarkdownView` uses, so what this file calls code, maths or prose is what the screen will draw. Only the parts of a
 * node the text repairs read are typed.
 */
export type MdNode = {
  type: string;
  value?: string;
  /** A code block's language and the rest of its info string; a flow formula's text after its opening `$$`. */
  lang?: string | null;
  meta?: string | null;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

// A text is parsed by several repairs in a row, and again when a stream grows by a word: the last few trees are kept.
// The trees are read, never changed.
const recent = new Map<string, MdNode>();
const RECENT = 16;

/** The tree of `text`. */
export function parseMarkdown(text: string): MdNode {
  const known = recent.get(text);
  if (known) return known;
  const tree = processor.parse(text) as unknown as MdNode;
  if (recent.size >= RECENT) recent.delete(recent.keys().next().value!);
  recent.set(text, tree);
  return tree;
}

/** Where a node starts and ends in the text it was parsed from. */
export const start = (node: MdNode): number => node.position!.start.offset!;
export const end = (node: MdNode): number => node.position!.end.offset!;

/** Calls `visit` on every node, parents before children; `visit` returns false to leave a node's children out. */
export function walk(node: MdNode, visit: (node: MdNode, parent: MdNode | null) => boolean | void, parent: MdNode | null = null): void {
  if (visit(node, parent) === false) return;
  for (const child of node.children ?? []) walk(child, visit, node);
}

/** Whether `offset` of `text` lies in a list item, as the parser reads the text. */
export function inListItem(text: string, offset: number): boolean {
  let found = false;
  walk(parseMarkdown(text), (node) => {
    if (found || !node.position || offset < start(node) || offset >= end(node)) return false;
    if (node.type === "listItem") found = true;
  });
  return found;
}

/** How many columns a line's leading spaces and tabs take, a tab reaching the next multiple of four. */
export const indentWidth = (indent: string): number =>
  [...indent].reduce((column, char) => (char === "\t" ? column + 4 - (column % 4) : column + 1), 0);
