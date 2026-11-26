import { mapOutsideCode } from "../../../shared/outside-code";
import { PASSAGE_MARK, replaceMarkRuns, splitCitationGroups } from "../../../shared/smart-text";

/** Whether a [Pn] mark names a passage the page knows, such as one stored with the reply. */
export type KnownPassage = (passageId: number) => boolean;

/**
 * Turns each [Pn] mark into an empty `cite:` link, which the Markdown view draws as an invisible anchor: the text shows
 * no mark, and the sources row finds the words a passage supports from it. The spaces before a mark go with it, so
 * "volume [P1]." reads "volume." A mark for a passage `known` does not name (the model cited one the reply never stored)
 * is dropped, since nothing can open it. Only a view that knows its passages calls this; any other shows a stored text's
 * [Pn] as written. Whitespace
 * is touched only next to a run of marks (`replaceMarkRuns`), so the Markdown keeps its blocks.
 */
const TRAILING_MARKS = new RegExp(`^([ \\t>]*)(\\$\\$)[ \\t]*(${PASSAGE_MARK}(?:[ \\t]*[,;]?[ \\t]*${PASSAGE_MARK})*[ \\t.,;:!?]*)$`, "i");
const SINGLE_LINE_DISPLAY = new RegExp(`^([ \\t>]*)(\\$\\$(?:(?!\\$\\$)[^\\n])+\\$\\$)[ \\t]*(${PASSAGE_MARK}(?:[ \\t]*[,;]?[ \\t]*${PASSAGE_MARK})*[ \\t.,;:!?]*)$`, "i");

/**
 * Moves a run of citation marks placed on the same line after a display formula's closing `$$` ("$$x$$ [P1]" or
 * "$$\nx\n$$ [P1]") onto its own paragraph before `replaceMarkRuns` parses the Markdown. Runs only outside Markdown code
 * blocks and code spans (`mapOutsideCode`) so indented code and blockquoted fences stay intact. Without this split,
 * remark-math drops a single-line `$$x$$` to inline math or leaves a multi-line `$$` block unclosed; with it, the formula
 * stays centered, `rehypeMarks` hides the anchor paragraph, and `citedRanges` still tints the formula.
 */
function separateFromDisplayMath(markdown: string): string {
  return mapOutsideCode(markdown, (chunk, start, end) => {
    // A chunk edge next to a code span is the middle of a line, which no rewrite below may split.
    const startsLine = start === 0 || markdown[start - 1] === "\n";
    const endsLine = end === markdown.length || markdown[end] === "\n" || markdown[end] === "\r";
    let inMath = false;
    const lines = chunk.split("\n");
    return lines
      .map((line, index) => {
        if ((index === 0 && !startsLine) || (index === lines.length - 1 && !endsLine)) return line;
        if (/^[ \t>]*\$\$[ \t]*$/.test(line)) {
          inMath = !inMath;
          return line;
        }
        if (inMath) {
          const closing = TRAILING_MARKS.exec(line);
          if (closing) {
            inMath = false;
            return `${closing[1]}${closing[2]}\n\n${closing[1]}${closing[3]}`;
          }
          return line;
        }
        const single = SINGLE_LINE_DISPLAY.exec(line);
        return single ? `${single[1]}${single[2]}\n\n${single[1]}${single[3]}` : line;
      })
      .join("\n");
  });
}

export function linkCitations(markdown: string, known: KnownPassage): string {
  return replaceMarkRuns(separateFromDisplayMath(markdown), PASSAGE_MARK, (run) =>
    [...splitCitationGroups(run).matchAll(/\[P(\d+)\]/g)]
      .map(([, raw]) => Number(raw))
      .map((id) => (known(id) ? `[](cite:p${id})` : ""))
      .join(""),
  );
}

/**
 * A `cite:` link as the passage number it names, or null when the href is not one. With `known`, only numbers it knows
 * count: a model that writes `[x](cite:p9)` for a passage it never had gets no anchor. Without it every number counts.
 */
export function citedPassage(href: string | undefined, known?: KnownPassage): number | null {
  const id = href?.match(/^cite:p(\d+)$/)?.[1];
  if (id === undefined) return null;
  return !known || known(Number(id)) ? Number(id) : null;
}
