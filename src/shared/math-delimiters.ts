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

/** A `$…$` or `$$…$$` pair with something between the dollars, spaces at its edges included, as the renderer draws it. */
const DOLLAR_FORMULA = /\$(?=[^$]*\S)[^$]+\$/;

/** Whether `text` has a formula in any delimiter the app renders: `$…$`, `$$…$$`, `\\(…\\)` or `\\[…\\]`. Code does not count. */
export function hasFormula(text: string): boolean {
  let found = false;
  mapOutsideCode(normalizeMathDelimiters(text), (chunk) => {
    if (DOLLAR_FORMULA.test(chunk)) found = true;
    return chunk;
  });
  return found;
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
 * Book text that names a formula or a place for a reader the app does not have. Import already writes a `{{formula:1.5}}`
 * the book has a formula for as that formula; one it has none for (a book imported before that, or a number the book never
 * defines) reads "eq. 1.5", a reference in Italian and English alike, never the bare number a student could take for the
 * formula. `[text](ref:chapter/1#p2)` or `[text](ref:formula/1.2)` is its text. Code is left alone.
 */
export function resolveBookRefs(input: string): string {
  if (!input.includes("{{formula:") && !input.includes("](ref:")) return input;
  return mapOutsideCode(input, (text) =>
    text
      .replace(/\{\{formula:([\d.]+)\}\}/g, "eq. $1")
      .replace(/\[([^\]]+)\]\(ref:(?:formula\/[\d.]+|chapter\/\d+(?:#p\d+)?)\)/g, "$1"),
  );
}

/** A formula in prose, read as LaTeX reads it: `\$` never opens or closes one. `end` is the end of the text when it is open. */
type MathSpan = { start: number; end: number; open: string; close: string; closed: boolean };

/**
 * The formulas of a prose chunk, in any of the four delimiters. An inline `$` opens only before a non-space and, like a
 * `\(`, stays in its paragraph; a `$$` or `\[` may run over blank lines. A formula that never closes is the last span
 * with `closed: false`, which is what a text still being written ends in.
 */
function scanMath(text: string, literals: number[] = []): MathSpan[] {
  const spans: MathSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char !== "\\" && char !== "$") {
      i += 1;
      continue;
    }
    let open: string;
    let close: string;
    if (char === "\\") {
      const next = text[i + 1];
      // `\$`, `\\` and every other escape are one unit that opens nothing.
      if (next !== "(" && next !== "[") {
        i += 2;
        continue;
      }
      open = `\\${next}`;
      close = next === "(" ? "\\)" : "\\]";
    } else {
      open = text[i + 1] === "$" ? "$$" : "$";
      close = open;
    }
    // A `$` before a space may open a formula (`$ x $`, which remark-math draws), but one that nothing closes is a dollar
    // sign, as in "25 $ e basta", and never a formula still being written. A `$` that ends the text may become either.
    const padded = open === "$" && i + 1 < text.length && !/\S/.test(text[i + 1]!);
    const inline = open === "$" || open === "\\(";
    let at = i + open.length;
    let end = -1;
    while (at < text.length) {
      if (text[at] === "\\" && close[0] === "\\" && text.startsWith(close, at)) {
        end = at;
        break;
      }
      if (text[at] === "\\") {
        at += 2;
        continue;
      }
      if (close === "$" || close === "$$") {
        if (text.startsWith(close, at)) {
          end = at;
          break;
        }
      }
      if (inline && text[at] === "\n" && /^\n[ \t]*\n/.test(text.slice(at))) break;
      at += 1;
    }
    if (end === -1) {
      // Never closed within its paragraph (inline) or its text (display): the end of an unfinished text, or plain characters.
      if (at >= text.length && !padded) spans.push({ start: i, end: text.length, open, close, closed: false });
      if (open[0] === "$") for (let k = 0; k < open.length; k += 1) literals.push(i + k);
      i += open.length;
      continue;
    }
    spans.push({ start: i, end: end + close.length, open, close, closed: true });
    i = end + close.length;
  }
  return spans;
}

/**
 * Two things that make remark-math pair the wrong dollar signs.
 *
 * A `\$` in a formula is a dollar sign, which KaTeX draws, but remark-math ends the formula at its `$`: `\(25\ \$\)`
 * became `$25\ \$$`, which drew an error. `\char36{}` is the same sign without a `$` in the text. The braces end the
 * number, so a digit after it stays a digit.
 *
 * A dollar sign in prose ("25 $") that no formula closes is escaped when the text also has `\( … \)` or `\[ … \]`
 * formulas: they become `$ … $`, and the price would pair with the first of them and typeset the words between as a
 * formula while the real formula showed as source.
 */
function dollarsInMath(text: string): string {
  const converts = text.includes("\\(") || text.includes("\\[");
  if (!text.includes("\\$") && !(converts && text.includes("$"))) return text;
  const literals: number[] = [];
  const spans = scanMath(text, literals);
  const edits: Array<{ at: number; to: number; with: string }> = [];
  for (const span of spans) {
    if (!span.closed) continue;
    const body = text.slice(span.start + span.open.length, span.end - span.close.length);
    if (body.includes("\\$"))
      edits.push({
        at: span.start,
        to: span.end,
        with: span.open + body.replace(/\\\$/g, "\\char36{}") + span.close,
      });
  }
  if (converts) for (const at of literals) edits.push({ at, to: at + 1, with: "\\$" });
  edits.sort((a, b) => a.at - b.at);
  let out = "";
  let from = 0;
  for (const edit of edits) {
    out += text.slice(from, edit.at) + edit.with;
    from = edit.to;
  }
  return out + text.slice(from);
}

/** An equation alone on the last line, `\ce{C3H8 + 5O2 ->`, waits as a display placeholder until its brace closes. */
function holdChemistryLine(chunk: string): string {
  const line = /(?:^|\n)([ \t]*)(\\(?:ce|pu)\{[^\n]*)$/.exec(chunk);
  if (!line) return chunk;
  const text = line[2]!;
  const braces = [...text].reduce((depth, char) => depth + (char === "{" ? 1 : char === "}" ? -1 : 0), 0);
  if (braces <= 0 || text.includes("$")) return chunk;
  return `${chunk.slice(0, line.index + (line[0].startsWith("\n") ? 1 : 0))}[…](pyxis-math:display:${Math.min(text.length, 120)})`;
}

/**
 * The text of an answer that is still being written, with a formula whose closing delimiter has not arrived turned into
 * `[…](pyxis-math:<inline|display>:<characters so far>)`, which the reader draws as a quiet placeholder of about its size.
 * Without it the half-formula shows as raw source (`$m = 2\ \te`) or, for `$$`, as a KaTeX error. Code stays as it is.
 */
export function holdOpenMath(input: string): string {
  return mapOutsideCode(input, (chunk, _start, end) => {
    if (end !== input.length) return chunk;
    const open = scanMath(chunk).find((span) => !span.closed);
    if (!open) return holdChemistryLine(chunk);
    const display = open.open === "$$" || open.open === "\\[";
    const size = Math.min(chunk.length - open.start - open.open.length, 120);
    const lead = chunk.slice(0, open.start);
    const onOwnLine = /(?:^|\n)[ \t]*$/.test(lead);
    return `${lead}${display && !onOwnLine ? "\n\n" : ""}[…](pyxis-math:${display ? "display" : "inline"}:${size})`;
  });
}

/**
 * A chemical equation a model put alone, in a code fence of its own (no language or a LaTeX one) or with no delimiter
 * at all, is a formula: the fence would show `\ce{…}` as code and the bare line as text. Only a lone `\ce{…}` or
 * `\pu{…}` is read this way, so a code block stays code, and a fence inside a longer one is the longer one's text: the
 * traversal is the one that finds code everywhere else, and a closing fence must be the opening one's marker, as wide or wider.
 */
function unfenceChemistry(input: string): string {
  if (!input.includes("\\ce{") && !input.includes("\\pu{")) return input;
  return mapOutsideCode(
    input,
    (text) => text,
    (code, kind) => {
      if (kind !== "fence") return code;
      const fence = /^(`{3,}|~{3,})[ \t]*(?:latex|tex|katex|mhchem|chem)?[ \t]*\n[ \t]*(\\(?:ce|pu)\{[^\n]*\})[ \t]*\n([`~]+)[ \t]*(\n?)$/i.exec(code);
      if (!fence) return code;
      const [, open, body, close, lineEnd] = fence;
      return close === open![0]!.repeat(close!.length) && close!.length >= open!.length
        ? `$$\n${body}\n$$${lineEnd}`
        : code;
    },
  );
}

/** Commands whose argument is words, not mathematics. */
const TEXT_COMMANDS = /\\(?:text|textbf|textit|textrm|textsf|texttt|textnormal|mbox|mathrm|emph)\{[^{}]*\}/g;

/**
 * A text that is nothing but LaTeX, with no delimiter and no prose, as a model writes it in a field meant for one
 * formula (the answer of a worked example): it would show its backslash commands as text. It needs something
 * mathematical outside the commands that hold words (an operator, a sub- or superscript, a command such as `\vec`), and
 * no sentence: three words in a row make it prose that starts with a command.
 */
function bareFormula(input: string): string {
  const text = input.trim();
  if (!/^\\[A-Za-z]+/.test(text) || /[$`]|\\[([]|\n[ \t]*\n/.test(text)) return input;
  const outside = text.replace(TEXT_COMMANDS, "");
  const mathematical = /[=<>^_+*/]|\\(?!(?:text|textbf|textit|textrm|textsf|texttt|textnormal|mbox|mathrm|emph)\b)[A-Za-z]+/.test(outside);
  if (!mathematical) return input;
  const words = outside.replace(/\\[A-Za-z]+/g, "");
  if (/\p{L}{2,}[ \t]+\p{L}{2,}[ \t]+\p{L}{2,}/u.test(words)) return input;
  return `$${text}$`;
}

/**
 * Turns \\( … \\) and \\[ … \\] into $ / $$ forms for remark-math, and Markdown bold inside a formula into \\mathbf.
 * Leaves $ and $$ untouched.
 */
export function normalizeMathDelimiters(input: string): string {
  const source = bareFormula(unfenceChemistry(resolveBookRefs(input)));
  return mapOutsideCode(source, (chunk, start, end) => {
    // Per prose chunk, so code stays as written and the `$` count never reaches across a code block. Before the
    // delimiters are converted: the repair reads \( ... \) and \[ ... \] as math, and trimming a formula's edges
    // would drop a line break that is really the start of `\nu`.
    const atLineStart = start === 0 || source[start - 1] === "\n";
    const text = chemistryLines(
      dollarsInMath(repairLatexEscapes(chunk, atLineStart)),
      atLineStart,
      end === source.length || source[end] === "\n",
    );
    let out = text.replace(
      /\\\[([\s\S]*?)\\\]/g,
      (_, body: string) => `\n$$\n${body.trim()}\n$$\n`,
    );
    // An inline formula stays in its paragraph: a `\(` that never closes must not swallow the paragraphs after it.
    out = out.replace(/\\\(((?:(?!\n[ \t]*\n)[\s\S])*?)\\\)/g, (_, body: string) => `$${body}$`);
    return boldInMath(out);
  });
}

/**
 * A line that is only `\ce{…}` or `\pu{…}` becomes a display formula, unless it is already inside a formula. A chunk
 * edge beside inline code is not a line edge.
 */
function chemistryLines(text: string, startsLine: boolean, endsLine: boolean): string {
  if (!text.includes("\\ce{") && !text.includes("\\pu{")) return text;
  const spans = scanMath(text).filter((span) => span.closed);
  return text.replace(
    /^([ \t]*)(\\(?:ce|pu)\{[^$\n]*\})[ \t]*$/gm,
    (match, indent: string, body: string, at: number) =>
      (!startsLine && at === 0) ||
      (!endsLine && at + match.length === text.length) ||
      spans.some((span) => at >= span.start && at < span.end)
        ? match
        : `${indent}$$\n${indent}${body}\n${indent}$$`,
  );
}

/**
 * Puts a `$$ … $$` that starts and ends at a line edge on lines of its own. remark-math reads `$$x$$` on one line as
 * inline math, so without this a model's display formula renders small and left-aligned like body text. It reads
 * `$$a,\n\qquad b.$$` as a fence with `a,` for its info string and no end, so the formula's first line is lost, the
 * block runs on, and every `$` after it pairs with the wrong one.
 */
export function displayMathLines(input: string): string {
  return mapOutsideCode(input, (text, start, end) => {
    // A chunk edge beside inline code is not a line edge: `code` $$x$$ keeps its formula inline.
    const openMid = start > 0 && input[start - 1] !== "\n";
    const closeMid = end < input.length && input[end] !== "\n";
    return text.replace(
      /^([ \t]*)\$\$((?:(?!\$\$|\n[ \t]*\n)[\s\S])+?)\$\$[ \t]*$/gm,
      (match, indent: string, body: string, at: number) =>
        (openMid && at === 0) || (closeMid && at + match.length === text.length)
          ? match
          : `${indent}$$\n${indent}${body.trim()}\n${indent}$$`,
    );
  });
}
