import { displayMathLines, holdOpenMath, normalizeMathDelimiters } from "../../../shared/math-delimiters";
import { linkCitations, type CitationResolver } from "./citations";

/**
 * A marker after the paragraph of each step: `[check](mathcheck:<index>)` in a paragraph of its own, for the math check of
 * the step at that index. A step the text no longer holds gets none.
 */
function markChecks(body: string, steps: readonly string[]): string {
  const inserts = new Map<number, string[]>();
  steps.forEach((step, index) => {
    const start = body.indexOf(step);
    if (start < 0) return;
    const next = body.indexOf("\n\n", start + step.length);
    const at = next < 0 ? body.length : next;
    inserts.set(at, [...(inserts.get(at) ?? []), `[check](mathcheck:${index})`]);
  });
  let marked = body;
  for (const [at, markers] of [...inserts].sort((a, b) => b[0] - a[0])) {
    marked = `${marked.slice(0, at)}\n\n${markers.join(" ")}\n\n${marked.slice(at)}`;
  }
  return marked;
}

/**
 * The text a Markdown view hands to react-markdown: check markers after the paragraphs of their steps, citations as
 * links, formulas in one delimiter, display formulas on lines of their own. `writing` says the text is still arriving, so
 * a formula whose closing delimiter has not come yet waits as a placeholder instead of showing as raw source or, for
 * `$$`, as an error. That comes first: a marker put at the end of a paragraph would stand between an open formula and the
 * end of the text, and the formula would no longer look open.
 */
export function markdownSource(
  body: string,
  resolver?: CitationResolver,
  writing = false,
  checkSteps: readonly string[] = [],
): string {
  const held = writing ? holdOpenMath(body) : body;
  return displayMathLines(normalizeMathDelimiters(linkCitations(markChecks(held, checkSteps), resolver)));
}
