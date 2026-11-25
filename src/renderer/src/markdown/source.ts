import {
  displayMathLines,
  holdOpenMath,
  normalizeMathDelimiters,
  repairLatexInProse,
} from "../../../shared/math-delimiters";
import { mapFigureBlocks } from "../../../shared/smart-text";
import { linkCitations, type KnownPassage } from "./citations";

/**
 * A marker after the paragraph of each step: `[check](mathcheck:<index>)` in a paragraph of its own, for the math check of
 * the step at that index. A step the text no longer holds gets none. The marker of a step in a list item or a quote is
 * indented like the step's line, so it stays in the item and the list goes on after it.
 */
function markChecks(body: string, steps: readonly string[]): string {
  const inserts = new Map<number, { lead: string; markers: string[] }>();
  steps.forEach((step, index) => {
    const start = body.indexOf(step);
    if (start < 0) return;
    const next = body.indexOf("\n\n", start + step.length);
    const at = next < 0 ? body.length : next;
    // The step's line, which starts with its list marker when the step is the item's first paragraph.
    const line = body.slice(body.lastIndexOf("\n", start - 1) + 1, start + step.length);
    const lead = (/^(?:[ \t>]|[-*+](?=[ \t])|\d+[.)](?=[ \t]))*/.exec(line)?.[0] ?? "").replace(/[-*+]|\d+[.)]/g, (marker) =>
      " ".repeat(marker.length),
    );
    const insert = inserts.get(at) ?? { lead, markers: [] };
    insert.markers.push(`[check](mathcheck:${index})`);
    inserts.set(at, insert);
  });
  let marked = body;
  for (const [at, { lead, markers }] of [...inserts].sort((a, b) => b[0] - a[0])) {
    marked = `${marked.slice(0, at)}\n\n${lead}${markers.join(" ")}\n\n${marked.slice(at)}`;
  }
  return marked;
}

/**
 * The text a Markdown view hands to react-markdown: check markers after the paragraphs of their steps, citations as
 * links, formulas in one delimiter, display formulas on lines of their own. `writing` says the text is still arriving, so
 * a formula whose closing delimiter has not come yet waits as a placeholder instead of showing as raw source or, for
 * `$$`, as an error. That comes after the LaTeX escapes are repaired, so the formula is classified as it will be drawn,
 * and before the markers: one put at the end of a paragraph would stand between an open formula and the end of the text,
 * and the formula would no longer look open.
 */
export function markdownSource(
  body: string,
  known?: KnownPassage,
  writing = false,
  checkSteps: readonly string[] = [],
): string {
  // A figure block indented as far as Markdown's indented code, in a list item, is lifted to where it reads as a figure.
  // The text is classified as it will be drawn: its LaTeX escapes (a `\times` that arrived as a tab) are back first.
  const repaired = repairLatexInProse(mapFigureBlocks(body, () => null));
  const held = writing ? holdOpenMath(repaired) : repaired;
  const steps = checkSteps.map(repairLatexInProse);
  return displayMathLines(normalizeMathDelimiters(linkCitations(markChecks(held, steps), known)));
}
