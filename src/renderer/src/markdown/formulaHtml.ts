import katex, { type KatexOptions } from "katex";
import { noteFormulaFailure } from "./formulaFailure";
import "katex/dist/katex.min.css";
import "./formula.css";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * KaTeX's HTML for a formula drawn outside Markdown. One KaTeX cannot draw shows as its source in the text's own colour
 * and a plain monospace face, as it does in Markdown (`rehypePlugins`), and is counted.
 */
export function formulaHtml(latex: string, options: Omit<KatexOptions, "throwOnError"> = {}): string {
  try {
    return katex.renderToString(latex, { ...options, throwOnError: true });
  } catch {
    noteFormulaFailure(latex);
    return `<span class="px-formula-source">${escapeHtml(latex)}</span>`;
  }
}
