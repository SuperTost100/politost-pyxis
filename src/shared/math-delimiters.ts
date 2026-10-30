import { repairLatexEscapes } from "./latex-repair";
import { mapOutsideCode } from "./outside-code";

export { mapOutsideCode };

/**
 * `$ … $` and `$$ … $$` spans, as remark-math reads them: an inline span opens before a non-space, closes after one and
 * stays on its line; `\$` is a literal dollar sign.
 */
const MATH_SPAN = /\$\$[\s\S]+?\$\$|(?<!\\)\$(?=\S)[^\n$]*?(?<=\S)(?<!\\)\$/g;

/** Start and end offsets of the math spans in `text`. */
export function mathSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(MATH_SPAN)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * KaTeX has no Markdown: `**b**` inside a formula draws two asterisk glyphs around b. Writes it as `\mathbf{b}`.
 * Needs `**` hugging its text, so `f ** g` stays.
 */
function boldInMath(text: string): string {
  return text.replace(MATH_SPAN, (span) =>
    span.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "\\mathbf{$1}"),
  );
}

/**
 * Book text that names a formula or a place for a reader the app does not have: `{{formula:1.5}}` is the number the book
 * prints, `(1.5)`, and `[text](ref:chapter/1#p2)` or `[text](ref:formula/1.2)` is its text. Code is left alone.
 */
export function resolveBookRefs(input: string): string {
  if (!input.includes("{{formula:") && !input.includes("](ref:")) return input;
  return mapOutsideCode(input, (text) =>
    text
      .replace(/\{\{formula:([\d.]+)\}\}/g, "($1)")
      .replace(/\[([^\]]+)\]\(ref:(?:formula\/[\d.]+|chapter\/\d+(?:#p\d+)?)\)/g, "$1"),
  );
}

/**
 * Turns \\( … \\) and \\[ … \\] into $ / $$ forms for remark-math, and Markdown bold inside a formula into \\mathbf.
 * Leaves $ and $$ untouched.
 */
export function normalizeMathDelimiters(input: string): string {
  const source = resolveBookRefs(input);
  return mapOutsideCode(source, (chunk, start) => {
    // Per prose chunk, so code stays as written and the `$` count never reaches across a code block. Before the
    // delimiters are converted: the repair reads \( ... \) and \[ ... \] as math, and trimming a formula's edges
    // would drop a line break that is really the start of `\nu`.
    const text = repairLatexEscapes(chunk, start === 0 || source[start - 1] === "\n");
    let out = text.replace(
      /\\\[([\s\S]*?)\\\]/g,
      (_, body: string) => `\n$$\n${body.trim()}\n$$\n`,
    );
    out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`);
    return boldInMath(out);
  });
}

/**
 * Puts a `$$ … $$` that stands alone on its line on lines of its own. remark-math reads `$$x$$` on one line as inline
 * math, so without this a model's display formula renders small and left-aligned like body text.
 */
export function displayMathLines(input: string): string {
  return mapOutsideCode(input, (text, start, end) => {
    // A chunk edge beside inline code is not a line edge: `code` $$x$$ keeps its formula inline.
    const openMid = start > 0 && input[start - 1] !== "\n";
    const closeMid = end < input.length && input[end] !== "\n";
    return text.replace(
      /^([ \t]*)\$\$((?:(?!\$\$)[^\n])+)\$\$[ \t]*$/gm,
      (match, indent: string, body: string, at: number) =>
        (openMid && at === 0) || (closeMid && at + match.length === text.length)
          ? match
          : `${indent}$$\n${indent}${body.trim()}\n${indent}$$`,
    );
  });
}
