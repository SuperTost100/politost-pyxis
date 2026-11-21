import { repairLatexEscapes } from "./latex-repair";
import { end, parseMarkdown, start, walk, type MdNode } from "./markdown-tree";
import { codeRanges, mapOutsideCode } from "./outside-code";

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

/** A change to a text: `from` to `to` becomes `text`. */
type Edit = { from: number; to: number; text: string };

/** The edits made together, in order; one that overlaps an earlier one is dropped. */
function applyEdits(text: string, edits: Edit[]): string {
  let out = "";
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (edit.from < at) continue;
    out += text.slice(at, edit.from) + edit.text;
    at = edit.to;
  }
  return out + text.slice(at);
}

/** A repaired text and where each of its places was in the text it was made from, so a place found in one is found in the other. */
type Rewritten = { text: string; back: (at: number) => number };
const unchanged = (text: string): Rewritten => ({ text, back: (at) => at });

/** `from` with `edits` made. */
function rewrite(from: Rewritten, edits: Edit[]): Rewritten {
  const kept: Edit[] = [];
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (edit.from < at) continue;
    kept.push(edit);
    at = edit.to;
  }
  if (!kept.length) return from;
  return {
    text: applyEdits(from.text, kept),
    back: (place) => {
      let moved = 0;
      for (const edit of kept) {
        const begins = edit.from + moved;
        if (place < begins) break;
        // A place in what an edit wrote is the place the edit began at.
        if (place < begins + edit.text.length) return from.back(edit.from);
        moved += edit.text.length - (edit.to - edit.from);
      }
      return from.back(place - moved);
    },
  };
}

/** Commands whose argument is words, not mathematics. */
const TEXT_COMMANDS = /\\(?:text|textbf|textit|textrm|textsf|texttt|textnormal|mbox|mathrm|emph)\{[^{}]*\}/g;
const TEXT_COMMAND_NAMES = "text|textbf|textit|textrm|textsf|texttt|textnormal|mbox|mathrm|emph";

/** Two words in a row outside the commands that hold words: a sentence, which a formula is not. */
function hasProse(latex: string): boolean {
  return /\p{L}{2,}[ \t]+\p{L}{2,}/u.test(latex.replace(TEXT_COMMANDS, "").replace(/\\[A-Za-z]+/g, ""));
}

/** A text node of the parse: its source range, the paragraph, heading or table cell it is in, and what holds that. */
type Prose = { from: number; to: number; leaf: MdNode | null; container: MdNode | null };

/** The prose of a parsed text, as the parser reads it: its text nodes, which code and formulas are not. */
function proseOf(node: MdNode): Prose[] {
  const found: Prose[] = [];
  const visit = (child: MdNode, leaf: MdNode | null, container: MdNode | null) => {
    if (child.type === "text") found.push({ from: start(child), to: end(child), leaf, container });
    const isLeaf = ["paragraph", "heading", "tableCell"].includes(child.type);
    for (const grandchild of child.children ?? []) visit(grandchild, isLeaf ? child : leaf, isLeaf ? container : child);
  };
  visit(node, null, null);
  return found;
}

/** What the prose of a text holds that a formula can start or end with: `\(`, `\)`, `\[`, `\]` and dollar signs left as text. */
type Mark = { kind: "(" | ")" | "[" | "]" | "$"; at: number; width: number; prose: Prose };

/**
 * The marks in the prose of `text`. A backslash escapes the next character, so `\$` is no dollar sign here, and the
 * dollar signs are the ones the parser left as text, since it made a formula of every pair.
 */
function marksIn(text: string, prose: Prose[]): Mark[] {
  const marks: Mark[] = [];
  for (const range of prose) {
    for (let i = range.from; i < range.to; ) {
      if (text[i] === "\\") {
        const next = text[i + 1];
        if (next === "(" || next === ")" || next === "[" || next === "]") marks.push({ kind: next, at: i, width: 2, prose: range });
        i += 2;
      } else if (text[i] === "$") {
        let width = 1;
        while (text[i + width] === "$" && i + width < range.to) width += 1;
        marks.push({ kind: "$", at: i, width, prose: range });
        i += width;
      } else i += 1;
    }
  }
  return marks;
}

/**
 * The `\( … \)` and `\[ … \]` that close, and the `\(` and `\[` that never do. An inline pair is in one paragraph,
 * heading or table cell of the parse, so an unmatched `\(` in a list item does not take the `\)` of the next; a display
 * one may run over blocks, but not out of the quote, list item or other container it opens in.
 */
function pairMarks(marks: Mark[]): { pairs: Array<[Mark, Mark]>; open: Mark[] } {
  const delimiters = marks.filter((mark) => mark.kind !== "$");
  const pairs: Array<[Mark, Mark]> = [];
  const open: Mark[] = [];
  for (let i = 0; i < delimiters.length; i += 1) {
    const mark = delimiters[i]!;
    if (mark.kind === ")" || mark.kind === "]") continue;
    const closer = mark.kind === "(" ? ")" : "]";
    let j = i + 1;
    while (j < delimiters.length && delimiters[j]!.kind !== closer) j += 1;
    const found = delimiters[j];
    const together =
      found && (mark.kind === "(" ? found.prose.leaf === mark.prose.leaf : found.prose.container === mark.prose.container);
    if (!found || !together) open.push(mark);
    else {
      pairs.push([mark, found]);
      i = j;
    }
  }
  return { pairs, open };
}

/** A symbol or an operator that only mathematics has in it: what separates `x+1` and `2x` from `e l'area è`. */
const MATH_SYNTAX = /[=+*/^_\\{}<>-]/;

/**
 * Whether the inline formula `node` that remark-math made is a price paired with the next dollar sign and some prose: it
 * starts with a number and then runs on in words (`$25 and the area is $`, `$5 and $`), or it opens after a number with a
 * space or a punctuation mark of its own and holds words and nothing mathematical (`25 $ e l'area è $`, `15 $, e $`, not
 * `Step 2 $ x+1 $`), or it starts as a price (a number after it, or one before it) and runs over a line break to close at
 * the start of the next line, where a `$$` block or another formula begins. Except in that last case, a space comes before
 * its closing dollar sign.
 */
function pairsAPrice(text: string, node: MdNode): boolean {
  const from = start(node);
  if (node.type !== "inlineMath" || text[from + 1] === "$") return false;
  const value = node.value ?? "";
  const startsWithNumber = /^\s*\d/.test(value);
  const words = /\p{L}{2,}/u.test(value) && !MATH_SYNTAX.test(value);
  const next = /\n[ \t]*\$$/.test(text.slice(from, end(node)));
  const afterNumber = /^[,.;:!?)]*\s/.test(text.slice(from + 1)) && /\d\s?$/.test(text.slice(Math.max(0, from - 8), from));
  // A price's dollar sign pairs with the dollar sign that opens what comes next, so a space comes before the closing one.
  // One right after the last character closes a formula, such as `$2 ab!$`.
  const opensNext = /\s/.test(text[end(node) - 2] ?? "");
  return (
    // The closing dollar sign at the start of the next line is a price's only when something says the first is a price.
    (next && (startsWithNumber || afterNumber)) ||
    (opensNext && startsWithNumber && hasProse(value)) ||
    (opensNext && startsWithNumber && /\s/.test(value.trim()) && words) ||
    (opensNext && afterNumber && words)
  );
}

/** Where the formulas that are really prices begin: for the tests of what the repairs may take away. */
export function priceFormulas(text: string): number[] {
  const found: number[] = [];
  walk(parseMarkdown(text), (node) => {
    if (pairsAPrice(text, node)) found.push(start(node));
  });
  return found;
}

/**
 * The opening dollar sign of the first price `pairsAPrice` finds, escaped. Its closing dollar sign is then paired anew, with
 * a formula or with the next price (`7 $ fanno 12 $. Costa 12 $`), so the next price is looked for in the parse of that.
 */
function priceEdit(text: string): Edit | null {
  let found: Edit | null = null;
  walk(parseMarkdown(text), (node) => {
    if (found) return false;
    if (pairsAPrice(text, node)) found = { from: start(node), to: start(node), text: "\\" };
  });
  return found;
}

/** Whether a range lies in one text node. */
const inProse = (prose: Prose[], from: number, to: number) => prose.some((range) => range.from <= from && to <= range.to);

/**
 * What a text needs before the parser reads it, decided from a parse of the text as it is and applied to the ranges the
 * parser calls prose, never to code: `\( … \)` and `\[ … \]` become `$ … $` and `$$ … $$`, and a dollar sign left as text,
 * in a block with such a formula, is escaped: the formulas become `$ … $`, and a price would pair with the first of them.
 */
function convertEdits(text: string): Edit[] {
  const root = parseMarkdown(text);
  const marks = marksIn(text, proseOf(root));
  // A pair with a code span or a formula inside is not one more formula: the span would stop being code and the formula
  // would be taken in. Repairs add formulas, they never take one away.
  const taken = codeRanges(text);
  walk(root, (node) => {
    if (node.type === "inlineMath" || node.type === "math") taken.push([start(node), end(node)]);
  });
  const pairs = pairMarks(marks).pairs.filter(
    ([open, close]) => !taken.some(([from, to]) => open.at < to && from < close.at + 2),
  );
  const edits: Edit[] = [];
  const opens = new Set(pairs.map(([open]) => open.at));
  for (const [open, close] of pairs) {
    const body = text.slice(open.at + 2, close.at);
    if (open.kind === "[") {
      // The block's lines start as the container's do, so a formula in a quote or a list item stays in it.
      const line = text.slice(text.lastIndexOf("\n", open.at - 1) + 1, open.at);
      const lead = continuation(/^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d+[.)](?=[ \t])))*[ \t]*/.exec(line)![0]);
      edits.push({ from: open.at, to: close.at + 2, text: `\n${lead}$$\n${lead}${body.trim()}\n${lead}$$\n${lead}` });
      continue;
    }
    // `$x$$y$` is one formula to the parser: a space keeps two that touch apart, as it keeps one beside a `$` formula.
    const before = text[open.at - 1] === "$" ? " " : "";
    const after = text[close.at + 2] === "$" || opens.has(close.at + 2) ? " " : "";
    edits.push({ from: open.at, to: close.at + 2, text: `${before}$${body}$${after}` });
  }
  const blockOf = (at: number) => root.children?.findIndex((block) => start(block) <= at && at <= end(block));
  const blocks = new Set(pairs.map(([open]) => blockOf(open.at)));
  const inside = (at: number) => pairs.some(([open, close]) => open.at <= at && at < close.at + 2);
  for (const mark of marks) {
    if (mark.kind !== "$" || inside(mark.at) || !blocks.has(blockOf(mark.at))) continue;
    for (let k = 0; k < mark.width; k += 1) edits.push({ from: mark.at + k, to: mark.at + k, text: "\\" });
  }
  return edits;
}

/** How many backslashes end `text`. */
function trailingBackslashes(text: string): number {
  let n = 0;
  while (text[text.length - 1 - n] === "\\") n += 1;
  return n;
}

/** Whether `latex` has a dollar sign no backslash escapes: KaTeX has no use for one in math mode. */
function hasBareDollar(latex: string): boolean {
  for (let i = 0; i < latex.length; i += 1) {
    if (latex[i] === "\\") i += 1;
    else if (latex[i] === "$") return true;
  }
  return false;
}

/**
 * A `\$` in a formula is a dollar sign, which KaTeX draws, but remark-math ends the formula at its `$`: `\(25\ \$\)`
 * became `$25\ \$$`, which drew an error. `\char36{}` is the same sign without a `$` in the text (the braces end the
 * number, so a digit after it stays a digit). Which `\$` sit in formulas is read from a parse of the text with every one
 * of them already written that way: a formula there is a formula as its writer meant it, and the `\$` in it become
 * `\char36{}`; the ones in prose stay what they are, an escaped dollar sign.
 */
function dollarEdits(text: string, all = false): Edit[] {
  if (!text.includes("\\$")) return [];
  const code = codeRanges(text);
  const formulas: MdNode[] = [];
  walk(parseMarkdown(text), (node) => {
    if (node.type === "inlineMath" || node.type === "math") formulas.push(node);
  });
  const found: number[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    if (text[i] !== "\\") continue;
    if (text[i + 1] === "$" && !code.some(([from, to]) => from <= i && i < to)) {
      // One that already sits in a formula the parser read, and that KaTeX draws, is left as it is: a block, or a formula
      // whose `\$` has no bare dollar sign by it. Only one the parser took for the end of a formula is in question.
      const inside = formulas.find((node) => start(node) <= i && i < end(node));
      const broken = inside && inside.type === "inlineMath" && (end(inside) === i + 2 || hasBareDollar(inside.value ?? ""));
      if (!inside || broken) found.push(i);
    }
    i += 1;
  }
  const neutral = "\\char36{}";
  let swapped = "";
  let at = 0;
  for (const i of found) {
    swapped += text.slice(at, i) + neutral;
    at = i + 2;
  }
  swapped += text.slice(at);
  const meant: Array<[number, number]> = [];
  walk(parseMarkdown(swapped), (node) => {
    if (node.type === "inlineMath" || node.type === "math") meant.push([start(node), end(node)]);
  });
  return found.flatMap((i, k) => {
    const where = i + k * (neutral.length - 2);
    return all || meant.some(([from, to]) => from <= where && where + neutral.length <= to)
      ? [{ from: i, to: i + 2, text: neutral }]
      : [];
  });
}

/**
 * `input` put right where remark-math would read it other than its writer meant, and what the later steps ask the parser
 * about. `unfinished` is for a text still being written, where a formula with a `\$` in it may have no closing dollar sign
 * yet: every `\$` is then written without one, since a prose `\$` has none to pair with anyway.
 */
function prepared(input: string, unfinished = false): Rewritten {
  let text = unchanged(input);
  for (let round = 0; round < 40; round += 1) {
    const edit = nextBlockEdit(text.text);
    if (!edit) break;
    text = rewrite(text, [edit]);
  }
  text = rewrite(text, convertEdits(text.text));
  text = rewrite(text, dollarEdits(text.text, unfinished));
  // Each round escapes one dollar sign and adds none, so there are never more rounds than dollar signs.
  const dollars = text.text.split("$").length - 1;
  for (let round = 0; round < dollars; round += 1) {
    const edit = priceEdit(text.text);
    if (!edit) break;
    text = rewrite(text, [edit]);
  }
  return text;
}

/**
 * What is left once the formulas have no `$` but their own delimiters: a line that is only `\ce{…}` or `\pu{…}`, and a
 * fence that holds only that, are display formulas; a text that is only LaTeX, such as the answer of a worked example,
 * is a formula.
 */
function rewriteRest(text: string): string {
  const root = parseMarkdown(text);
  const prose = proseOf(root);
  const edits: Edit[] = [];
  for (const match of text.matchAll(/^([ \t]*)(\\(?:ce|pu)\{[^$\n]*\})[ \t]*$/gm)) {
    const from = match.index + match[1]!.length;
    const to = from + match[2]!.length;
    if (inProse(prose, from, to)) edits.push({ from, to, text: `$$\n${match[1]}${match[2]}\n${match[1]}$$` });
  }
  walk(root, (node, parent) => {
    // A standalone fence (not one in a longer fence or a list), whose only line is the equation. An indented block is no fence.
    if (node.type !== "code" || parent?.type !== "root" || !/^[`~]/.test(text.slice(start(node)))) return;
    if (node.meta || (node.lang && !/^(?:latex|tex|katex|mhchem|chem)$/i.test(node.lang))) return;
    if (/^\\(?:ce|pu)\{[^\n]*\}$/.test((node.value ?? "").trim()))
      edits.push({ from: start(node), to: end(node), text: `$$\n${(node.value ?? "").trim()}\n$$` });
  });
  const only = root.children?.length === 1 && root.children[0]!.type === "paragraph" ? root.children[0]! : null;
  if (only && edits.length === 0) {
    const slice = text.slice(start(only), end(only));
    if (isBareFormula(slice)) edits.push({ from: start(only), to: end(only), text: `$${slice}$` });
  }
  return edits.length ? applyEdits(text, edits) : text;
}

/**
 * A paragraph that is nothing but LaTeX, with no delimiter and no prose, as a model writes it in a field meant for one
 * formula: it would show its backslash commands as text. It needs something mathematical outside the commands that hold
 * words (an operator, a sub- or superscript, a command such as `\vec`), and no sentence.
 */
function isBareFormula(paragraph: string): boolean {
  if (!/^\\[A-Za-z]+/.test(paragraph) || /[$`]|\\[([]|\n[ \t]*\n/.test(paragraph)) return false;
  const outside = paragraph.replace(TEXT_COMMANDS, "");
  const mathematical = new RegExp(`[=<>^_+*/]|\\\\(?!(?:${TEXT_COMMAND_NAMES})\\b)[A-Za-z]+`).test(outside);
  return mathematical && !hasProse(paragraph);
}

/** KaTeX has no Markdown: `**b**` inside a formula draws two asterisk glyphs around b, and becomes `\mathbf{b}`. */
function boldInFormulas(text: string): string {
  const edits: Edit[] = [];
  walk(parseMarkdown(text), (node) => {
    if (node.type !== "inlineMath" && node.type !== "math") return;
    const source = text.slice(start(node), end(node));
    if (!source.includes("**")) return;
    const bold = source.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "\\mathbf{$1}");
    if (bold !== source) edits.push({ from: start(node), to: end(node), text: bold });
  });
  return edits.length ? applyEdits(text, edits) : text;
}

/**
 * A model that writes a LaTeX command with one backslash in a JSON string loses it: `\\times` arrives as a tab and
 * `imes`. The prose of the text, as the parser reads it, has them back (`repairLatexEscapes`). Before the delimiters are
 * converted: the repair reads \( ... \) and \[ ... \] as math, and trimming a formula's edges would drop a line break
 * that is really the start of `\nu`. Anything that classifies a text, as `holdOpenMath` does, does it on this text.
 */
export function repairLatexInProse(source: string): string {
  return mapOutsideCode(source, (chunk, from) => repairLatexEscapes(chunk, from === 0 || source[from - 1] === "\n"));
}

/**
 * Turns \\( … \\) and \\[ … \\] into $ / $$ forms for remark-math, and Markdown bold inside a formula into \\mathbf,
 * and repairs what a model's formulas need to be read as formulas (see `prepared` and `rewriteRest`). Code, as the
 * parser reads it, is left as written.
 */
export function normalizeMathDelimiters(input: string): string {
  return boldInFormulas(rewriteRest(prepared(repairLatexInProse(resolveBookRefs(input))).text));
}

/** Whether a line closes a `$$` block opened with `width` dollar signs: only dollar signs, at least as many, after any quote marks. */
const closesFence = (line: string, width: number) => (/^[ \t>]*(\$+)[ \t]*$/.exec(line)?.[1]?.length ?? 0) >= width;

/** What a line inside the container of `prefix` starts with: a quote mark stays, a list marker becomes the spaces it stands for. */
const continuation = (prefix: string) => prefix.replace(/[-*+](?=[ \t])|\d+[.)](?=[ \t])/g, (marker) => " ".repeat(marker.length));

/**
 * The first `$$` block of `text` that remark-math reads differently from what its writer meant, as an edit. The block's
 * lines are the parser's (`node.value`, without the quote marks and indentation of the container it is in), and a new line
 * starts with what the container's lines start with.
 */
function nextBlockEdit(text: string): Edit | null {
  let found: Edit | null = null;
  walk(parseMarkdown(text), (node) => {
    if (found) return false;
    if (node.type !== "math") return;
    const from = start(node);
    const to = end(node);
    const lines = text.slice(from, to).split("\n");
    const width = /^\$+/.exec(lines[0]!)![0].length;
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const lead = text.slice(lineStart, from);
    const opening = /^(?:[ \t>]|[-*+]|\d+[.)])*$/.test(lead) ? continuation(lead) : "";
    // A line of the block that ends in `$$` after its content never closes the block: it runs on to the next `$$`, or to the
    // end of the text, with every dollar sign after it paired wrongly. Only the first paragraph is looked at.
    const content = (node.value ?? "").split("\n");
    let offset = from + lines[0]!.length + 1;
    for (let k = 0; !found && k < content.length && k + 1 < lines.length; k += 1) {
      const source = lines[k + 1]!;
      const row = content[k]!.trimEnd();
      if (!row.trim()) break;
      // The first dollar sign of the run is no fence when a backslash escapes it: `\$$` ends a formula in one.
      const run = /\$+$/.exec(row)?.[0].length ?? 0;
      const escaped = run > 0 && trailingBackslashes(row.slice(0, row.length - run)) % 2 === 1;
      const fence = escaped ? run - 1 : run;
      if (fence >= width && row.slice(0, row.length - fence).trim()) {
        const at = offset + source.trimEnd().length - fence;
        found = { from: at, to: at, text: `\n${/^[ \t>]*/.exec(source)![0]}` };
      }
      offset += source.length + 1;
    }
    // Content on the line of the opening `$$` is read as its info string, and the formula's first line is lost. That is
    // a formula only when something closes the block; `$$ is a double dollar sign`, which nothing does, is prose.
    if (!found && node.meta?.trim() && lines.length > 1 && closesFence(lines[lines.length - 1]!, width))
      found = { from: from + width, to: from + width, text: `\n${opening}` };
    return false;
  });
  return found;
}

/** Every `$$x$$` alone on its line, which remark-math reads as inline maths, as an edit that makes it a block. */
function promotions(text: string): Edit[] {
  const edits: Edit[] = [];
  walk(parseMarkdown(text), (node, parent) => {
    if (node.type !== "inlineMath" || parent?.type !== "paragraph" || !text.startsWith("$$", start(node))) return;
    const from = start(node);
    const to = end(node);
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    const lineEnd = text.indexOf("\n", to) === -1 ? text.length : text.indexOf("\n", to);
    const before = text.slice(lineStart, from);
    if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(text.slice(to, lineEnd)))
      edits.push({ from, to, text: `$$\n${before}${(node.value ?? "").trim()}\n${before}$$` });
  });
  return edits;
}

/** `text` with the edits `next` finds made one at a time, each on the parse of what the last one left. */
function untilDone(text: string, next: (text: string) => Edit | null): string {
  for (let round = 0; round < 40; round += 1) {
    const edit = next(text);
    if (!edit) break;
    text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  }
  return text;
}

/**
 * Puts a `$$ … $$` that starts and ends at a line edge on lines of its own. remark-math reads `$$x$$` on one line as
 * inline math, so without this a model's display formula renders small and left-aligned like body text. The blocks that
 * remark-math misreads (`nextBlockEdit`) are put right first, as `normalizeMathDelimiters` does.
 */
export function displayMathLines(input: string): string {
  const right = untilDone(input, nextBlockEdit);
  return applyEdits(right, promotions(right));
}

/**
 * The text of an answer that is still being written, with a formula whose closing delimiter has not arrived turned into
 * `[…](pyxis-math:<inline|display>:<characters so far>)`, which the reader draws as a quiet placeholder of about its size.
 * Without it the half-formula shows as raw source (`$m = 2\ \te`) or, for `$$`, as a KaTeX error.
 *
 * The parser says what is open, on the text as the renderer will have it (`prepared`: its `\(` converted, its `\$` in
 * formulas written without a dollar sign, its prices not paired with other dollar signs), and the placeholder is made in
 * the text it was given. The last block of the text is an unfinished `$$` block, or ends in a delimiter the parser left as
 * text: a `\(`, a `\[` or a `$$`, or a `$` with a formula after it, which is a letter or a command or something
 * mathematical (a `^`, `_`, `=`, a brace, an operator). A dollar sign and a number, and then words, is a price and stays
 * text, as is one that ends a sentence (`12 $.`), and one with nothing after it yet may be either. Code is never held.
 */
export function holdOpenMath(input: string): string {
  const fixed = prepared(input, true);
  const text = fixed.text;
  const root = parseMarkdown(text);
  let leaf: MdNode = root;
  while (leaf.children?.length && ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(leaf.type))
    leaf = leaf.children[leaf.children.length - 1]!;
  if (leaf.type === "code" || !leaf.position || end(leaf) < text.trimEnd().length) return input;
  const hold = (at: number, display: boolean, size: number) => {
    const lead = input.slice(0, fixed.back(at));
    const own = /(?:^|\n)[ \t>]*$/.test(lead);
    return `${lead}${display && !own ? "\n\n" : ""}[…](pyxis-math:${display ? "display" : "inline"}:${Math.min(size, 120)})`;
  };
  if (leaf.type === "math") {
    const source = text.slice(start(leaf), end(leaf));
    const width = /^\$+/.exec(source)![0].length;
    const lines = source.split("\n");
    const closed = lines.length > 1 && closesFence(lines[lines.length - 1]!, width);
    return closed ? input : hold(start(leaf), true, source.length - width);
  }
  if (!["paragraph", "heading", "tableCell"].includes(leaf.type)) return input;
  const prose = proseOf(leaf);
  const marks = marksIn(text, prose);
  // A `\(`, a `\[` or a `$$` that nothing closes is a formula being written.
  const double = [...pairMarks(marks).open, ...marks.filter((mark) => mark.kind === "$" && mark.width >= 2)]
    .sort((a, b) => a.at - b.at)
    .at(-1);
  if (double) return hold(double.at, double.kind === "[" || double.kind === "$", text.length - double.at - double.width);
  const single = marks.filter((mark) => mark.kind === "$").at(-1);
  if (single) {
    // What follows the dollar sign, without the code spans the parser read there: a `+` in `x+y` makes no price a formula.
    let after = text.slice(single.at + 1, end(leaf));
    walk(leaf, (node) => {
      if (node.type !== "inlineCode" || start(node) <= single.at) return;
      const from = start(node) - single.at - 1;
      after = after.slice(0, from) + " ".repeat(end(node) - start(node)) + after.slice(from + end(node) - start(node));
    });
    // A punctuation mark and a space after it end a sentence, as in `fanno 12 $.`: no formula starts like that.
    const formula = /[\\^_={}<>+]/.test(after) || (!/^[,.;:!?)]*(?:\s|$)/.test(after) && /^[^\d\s]/.test(after));
    if (formula) return hold(single.at, false, after.length);
  }
  // An equation alone on the last line, `\ce{C3H8 + 5O2 ->`, waits until its brace closes.
  const line = /(?:^|\n)([ \t]*)(\\(?:ce|pu)\{[^\n]*)$/.exec(text.slice(0, end(leaf)));
  if (line && !line[2]!.includes("$")) {
    const from = text.lastIndexOf(line[2]!, end(leaf));
    const braces = [...line[2]!].reduce((depth, char) => depth + (char === "{" ? 1 : char === "}" ? -1 : 0), 0);
    if (braces > 0 && inProse(prose, from, end(leaf))) return hold(from, true, line[2]!.length);
  }
  return input;
}
