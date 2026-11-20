import katex from "katex";
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

const classesOf = (node: HastNode): unknown[] => {
  const classes = node.properties?.["className"];
  return Array.isArray(classes) ? classes : [];
};

/** The text of a hast node. */
function textOf(node: HastNode): string {
  return typeof node.value === "string" ? node.value : (node.children ?? []).map(textOf).join("");
}

/** Formulas KaTeX has drawn without a failure, so a text that streams checks each only once. Cleared when it grows large. */
const DRAWN = new Set<string>();
const DRAWN_MAX = 5000;

/** Whether KaTeX draws the formula. It says so itself: it throws where it cannot, and nothing about its output says it. */
function draws(latex: string, display: boolean): boolean {
  const key = `${display ? "d" : "i"}${latex}`;
  if (DRAWN.has(key)) return true;
  try {
    katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: "ignore" });
  } catch {
    return false;
  }
  if (DRAWN.size >= DRAWN_MAX) DRAWN.clear();
  DRAWN.add(key);
  return true;
}

/** What the reader sees for a formula KaTeX cannot draw: its source, in the text's own colour, in a plain monospace span. */
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
 * The formulas of a hast tree where remark-math left them, as rehype-katex finds them: a `code` with `math-inline`,
 * `math-display` or `language-math`, in a `pre` when it stands alone.
 */
function quiet(node: HastNode): void {
  node.children?.forEach((child, index) => {
    if (child.type !== "element") return;
    const classes = classesOf(child);
    const code = child.tagName === "pre" && child.children?.length === 1 ? child.children[0]! : null;
    if (code && code.type === "element" && classesOf(code).includes("language-math")) {
      const latex = textOf(code);
      if (!draws(latex, true)) node.children![index] = source(latex, true);
    } else if (classes.includes("math-inline") || classes.includes("math-display") || classes.includes("language-math")) {
      const latex = textOf(child);
      const display = classes.includes("math-display");
      if (!draws(latex, display)) node.children![index] = source(latex, display);
    } else quiet(child);
  });
}

/**
 * Before rehype-katex: a formula KaTeX cannot draw becomes its source, so rehype-katex never gets it and neither of the
 * two things it does with one reaches the reader, a `.katex-error` span in red or a formula with its unknown command in red.
 * Whether it fails is KaTeX's own answer to the same formula, never a colour in what it draws.
 */
function rehypeQuietFormulas() {
  return (tree: HastNode) => quiet(tree);
}

/** Tables, task lists and autolinks, plus `$...$` math. */
export const remarkPlugins = [remarkGfm, remarkMath];
/** Math only, for text that sits inside a button or label and can hold no blocks. */
export const inlineRemarkPlugins = [remarkMath];
export const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [rehypeQuietFormulas, rehypeKatex];
