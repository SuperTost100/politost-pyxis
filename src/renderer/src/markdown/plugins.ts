import type { Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { noteFormulaFailure } from "./formulaFailure";
import "katex/dist/katex.min.css";
import "./formula.css";
// Chemistry: \ce and \pu.
import "katex/contrib/mhchem";

// The plugins every Markdown view uses, so messages, lessons, inline text and printed pages draw math the same way.
// Built once: react-markdown can then reuse its pipeline across renders.

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

/** KaTeX's error colour, which it paints on a formula it cannot draw (a whole `.katex-error`, or an unknown command inside one). */
const ERROR_COLOR = "#cc0000";

const classesOf = (node: HastNode): unknown[] => {
  const classes = node.properties?.["className"];
  return Array.isArray(classes) ? classes : [];
};

/** The text of a hast node. */
function textOf(node: HastNode): string {
  return typeof node.value === "string" ? node.value : (node.children ?? []).map(textOf).join("");
}

function find(node: HastNode, match: (node: HastNode) => boolean): HastNode | null {
  if (match(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, match);
    if (found) return found;
  }
  return null;
}

const paintedRed = (node: HastNode) => String(node.properties?.["style"] ?? "").includes(`color:${ERROR_COLOR}`);

/** What the reader sees for a formula KaTeX could not draw: its source, in the text's own colour, in a plain monospace span. */
function source(text: string, display: boolean): HastNode {
  noteFormulaFailure(text);
  return {
    type: "element",
    tagName: "span",
    properties: { className: display ? ["px-formula-source", "is-display"] : ["px-formula-source"] },
    // `\char36{}` stands for `\$` where `normalizeMathDelimiters` made one safe for remark-math; the reader sees `\$`.
    children: [{ type: "text", value: text.replace(/\\char36\{\}/g, "\\$") }],
  };
}

/**
 * rehype-katex's error span does not say whether it replaced a display formula, which sits among blocks, or an inline one,
 * which sits in a line of text: a parent that is a block holder, or a list item with nothing else in it, means display.
 */
function standsAlone(parent: HastNode, child: HastNode): boolean {
  if (parent.type === "root" || parent.tagName === "blockquote") return true;
  return (
    parent.tagName === "li" &&
    (parent.children ?? []).every((sibling) => sibling === child || (sibling.type === "text" && !sibling.value?.trim()))
  );
}

function quiet(node: HastNode): void {
  node.children?.forEach((child, index) => {
    const classes = classesOf(child);
    if (child.type !== "element") return;
    if (classes.includes("katex-error")) {
      node.children![index] = source(textOf(child), standsAlone(node, child));
    } else if (classes.includes("katex-display") || classes.includes("katex")) {
      // An unknown command does not fail: KaTeX draws the formula with that command in its error colour.
      if (find(child, paintedRed)) {
        const tex = find(child, (n) => n.tagName === "annotation");
        node.children![index] = source(tex ? textOf(tex) : "", classes.includes("katex-display"));
      }
    } else quiet(child);
  });
}

/**
 * After rehype-katex: a formula it could not draw shows as its source, never in an error colour. rehype-katex tries
 * again without throwing when KaTeX fails, which gives either a red `.katex-error` span or a formula with a red command.
 */
function rehypeQuietFormulas() {
  return (tree: HastNode) => quiet(tree);
}

/** Tables, task lists and autolinks, plus `$...$` math. */
export const remarkPlugins = [remarkGfm, remarkMath];
/** Math only, for text that sits inside a button or label and can hold no blocks. */
export const inlineRemarkPlugins = [remarkMath];
export const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [[rehypeKatex, { errorColor: ERROR_COLOR }], rehypeQuietFormulas];
