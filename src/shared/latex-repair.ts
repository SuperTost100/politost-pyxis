import { codeRanges, mapOutsideCode } from "./outside-code";

/**
 * A model that writes LaTeX with one backslash inside a JSON string loses it: `\theta` becomes a tab and "heta", `\frac` a
 * form feed and "rac", `\nu` a line break and "u". `parseLooseJson` fixes the JSON text before it is read; these functions
 * put the backslash back in strings that were already read, as the engine's parser or an earlier save left them.
 */

// What follows the escape letter, for the LaTeX commands that start with b, f, n, r, t or v. Longest names first is not
// needed: each pattern ends at a word edge.
const BY_LETTER: Record<string, string[]> = {
  b: ["beta", "bar", "begin", "bf", "big", "bigg", "bigcup", "bigcap", "binom", "boldsymbol", "bot", "bullet", "because", "backslash", "bmod", "breve", "bowtie", "box"],
  f: ["frac", "forall", "flat", "fbox"],
  r: ["rho", "right", "rightarrow", "rangle", "rceil", "rfloor", "rbrace", "rbrack", "rvert", "rm", "rule", "rightleftharpoons"],
  t: ["text", "textbf", "textit", "textrm", "textsf", "texttt", "textnormal", "theta", "times", "tau", "tanh", "triangle", "triangleq", "therefore", "tfrac", "tbinom", "tilde", "thicksim", "to", "top", "tag", "tan", "tiny"],
  n: ["nu", "neq", "ne", "neg", "nsubseteq", "nabla", "not", "notin", "ni", "nolimits", "nmid", "ngtr", "nless", "nleq", "ngeq", "nsim", "ncong", "nexists", "nrightarrow", "nleftarrow", "nparallel", "newline", "nonumber", "normalsize"],
  v: ["vec", "vee", "varphi", "varepsilon", "vartheta", "varrho", "varsigma", "varpi", "varkappa", "varnothing", "vdots", "vdash", "vert", "vline", "vspace", "vphantom", "verb"],
};
// A tab or a line break is real text far more often than a form feed, a backspace or a vertical tab is, so these names are
// repaired only inside a `$` span: "\tto" and "\ntop" can start a word.
const GUARDED = new Set(["to", "top", "tag", "tan", "tiny", "ne", "ni", "not", "notin", "nu", "neq", "nolimits", "nmid", "ngtr", "nless", "nleq", "ngeq", "nsim", "ncong", "nexists", "nrightarrow", "nleftarrow", "nparallel", "newline", "nonumber", "normalsize", "nabla"]);
// LaTeX command names a doubled backslash in front of means the backslash was written twice, not a line break `\\` with a
// word after it. Every name the control-character repair knows, plus the other commands a model writes in a quiz.
const DOUBLED_OK = new Set([
  ...Object.values(BY_LETTER).flatMap((names) => names),
  ...("alpha gamma delta epsilon zeta eta iota kappa lambda mu xi pi sigma phi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega " +
    "cdot cdots ldots dots div pm mp leq geq le ge approx equiv sim propto infty to leftarrow Rightarrow Leftrightarrow Leftarrow leftrightarrow " +
    "sum prod int oint partial circ degree perp parallel angle cup cap subset subseteq supset in setminus emptyset exists " +
    "sin cos cot sec csc arcsin arccos arctan sinh cosh log ln exp lim max min sup inf det dim ker gcd deg Pr " +
    "sqrt dfrac hat dot ddot overline underline overrightarrow widehat widetilde mathrm mathbf mathbb mathcal mathit mathsf operatorname " +
    "left quad qquad hline end limits displaystyle underbrace overbrace choose over atop").split(" "),
]);
// What a model's JSON makes of a line break it wrote as `\n` once the string is read: a backslash and an n.
const AFTER_N = new Set(BY_LETTER.n);
// Commands that stand between two sides: ≠, ∋, ∉, ≰ and the rest, and the arrow `\to`.
const RELATIONS = new Set(["ne", "neq", "ni", "notin", "nleq", "ngeq", "nmid", "nsim", "ncong", "nless", "ngtr", "nsubseteq", "nparallel", "nrightarrow", "nleftarrow", "to"]);
const CONTROL: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/**
 * True when `index` is inside a `$...$`, `$$...$$`, `\(...\)` or `\[...\]` span that is not closed yet. An escaped dollar
 * sign is not a delimiter.
 */
function insideMath(text: string, index: number): boolean {
  let open: "$" | "$$" | "\\" | null = null;
  for (let i = 0; i < index; i += 1) {
    const char = text[i];
    if (char === "\\") {
      const next = text[i + 1];
      if (open === null && (next === "(" || next === "[")) open = "\\";
      else if (open === "\\" && (next === ")" || next === "]")) open = null;
      i += 1;
    } else if (char === "$") {
      const mark = text[i + 1] === "$" ? "$$" : "$";
      if (mark === "$$") i += 1;
      if (open === null) open = mark;
      else if (open === mark) open = null;
    }
  }
  return open !== null;
}

/** Where a row of a display formula begins: after its opening `$$` or `\[`, a `\\` row break or a `\begin{…}` and its arguments. */
const ROW_START = /(?:\$\$|\\\[|(?<!\\)\\\\|\\begin\{[^{}]*\}(?:\{[^{}]*\})*)$/;

/**
 * Whether the tab or line break at `at`, followed by the rest of the name `name` up to `end`, is really a tab or a line
 * break inside a formula, although `\name` is a LaTeX command too. The text around it decides:
 * - A relation (≠, ∉, →…) stands between two sides. One with nothing on its left in its row of a display formula, or
 *   with an exponent or an index right after it, is no relation: `$$` and a line break before `e^{-st}` is `e^{-st}`,
 *   never `\ne^{-st}`. Inline, `$\ne$` alone is the symbol, so there the left side may be empty.
 * - A line break where a formula laid out on lines has a line end is a line break: right after its opening `$$` or
 *   `\[` when its closing delimiter starts a line too, right after a `\\` row break, or after `\begin{…}`. Only a one-
 *   letter name counts (`\nu`, `\ne`, `\ni`), since only one letter is a variable: `$$` and a line break before
 *   `abla` is `\nabla` wherever it is.
 * `layout` says whether the second rule applies: it does to a control character, which a real line break may be, and
 * not to a backslash and an n written out, which is a real `\nu` far more often than a line break written twice.
 */
function textBreak(text: string, at: number, end: number, name: string, layout: boolean): boolean {
  if (RELATIONS.has(name) && (/[\^_]/.test(text[end] ?? "") || ROW_START.test(text.slice(0, at).trimEnd()))) return true;
  if (!layout || text[at] !== "\n" || name.length !== 2) return false;
  const line = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
  if (/(?<!\\)\\\\$|\\begin\{[^{}]*\}(?:\{[^{}]*\})*$/.test(line)) return true;
  const open = /(\$\$|\\\[)[ \t]*$/.exec(line)?.[1];
  if (!open) return false;
  const close = text.indexOf(open === "$$" ? "$$" : "\\]", at + 1);
  // A formula still being written is laid out as it began.
  return close < 0 || /\n[ \t>]*$/.test(text.slice(at, close));
}

/**
 * For the JSON text repair: whether the `\n` or `\t` escape at `at` of a string, which `text` holds read with that
 * escape as the control character it says, is a real line break or tab although the letters `name` (the escape's letter
 * and those after it) could be a LaTeX command. Inside a formula `textBreak` decides. Outside one:
 * - a tab that indents a line after a line break is a tab, in code or in prose;
 * - anything else in code is what it says;
 * - in prose a tab is a tab when no command of that name is known (`\tPrimo`); a `\text…` command counts as known. A
 *   line break before a whole command name is the command, as before.
 * A tab that opens the string is no indentation, although the parser would read the line as code because of it.
 */
export function escapeIsText(text: string, at: number, name: string): boolean {
  const before = text.slice(0, at);
  const tab = text[at] === "\t";
  const opensLine = tab && /(?:^|\n)[ \t]*$/.test(before);
  if (!opensLine && codeRanges(text).some(([from, to]) => at >= from && at < to)) return true;
  if (insideMath(text, at)) return textBreak(text, at, at + name.length, name, true);
  if (!tab) return false;
  return /\n[ \t]*$/.test(before) || !(BY_LETTER.t!.includes(name) || name.startsWith("text"));
}

const PATTERNS = Object.entries(BY_LETTER).map(([letter, rest]) => ({
  letter,
  pattern: new RegExp(`${CONTROL[letter]}(${rest.map((name) => name.slice(1)).join("|")})(?![A-Za-z])`, "g"),
}));

/**
 * A model told to write each LaTeX backslash twice in JSON does so again in a structured answer that is already decoded,
 * so `\\vec{A}` arrives as two backslashes, which KaTeX reads as a line break before "vec". In a formula, two
 * backslashes in front of a known command name go back to one. A real line break (`\\` then a space, a line end, `[2pt]`
 * or a single letter) is not touched.
 */
function undoubled(text: string): string {
  if (!text.includes("\\\\")) return text;
  return text.replace(/(?<!\\)\\\\([A-Za-z]{2,})/g, (match, name: string, offset: number, whole: string) =>
    DOUBLED_OK.has(name) && insideMath(whole, offset) ? `\\${name}` : match,
  );
}

/**
 * The same instruction asks for line breaks as `\n`, which a decoded structured answer keeps as a backslash and an n:
 * "…−2).\na) Calcolare". It becomes a real line break, except in front of a LaTeX command that starts with n (`\nabla`,
 * `\neq`, `\nu`) and when the backslash itself is escaped (`\\n`). Outside a formula the one-letter ones are a line break:
 * a list of options ends with "\ne)", and "\ne" alone is no command there.
 */
function literalBreaks(text: string): string {
  if (!text.includes("\\n")) return text;
  return text.replace(/(?<!\\)\\n([A-Za-z]*)/g, (match, tail: string, offset: number, whole: string) => {
    const name = `n${tail}`;
    if (!AFTER_N.has(name)) return `\n${tail}`;
    const command = insideMath(whole, offset) ? !textBreak(whole, offset, offset + match.length, name, false) : tail.length > 1;
    return command ? match : `\n${tail}`;
  });
}

/**
 * Restores `\beta`, `\frac`, `\nu`, `\right`, `\theta` and `\vec` commands turned into control characters. Real tabs and line breaks stay.
 * `atLineStart` says whether the text begins a line; a chunk that follows inline code does not, so its first tab is not indentation.
 */
export function repairLatexEscapes(text: string, atLineStart = true): string {
  let out = undoubled(literalBreaks(text));
  if (!/[\b\f\n\r\t\v]/.test(out)) return out;
  for (const { letter, pattern } of PATTERNS) {
    out = out.replace(pattern, (match, tail: string, offset: number, whole: string) => {
      const name = `${letter}${tail}`;
      // A tab that opens a line is indentation.
      const inMath = insideMath(whole, offset);
      if (letter === "t" && ((offset === 0 && atLineStart) || whole[offset - 1] === "\n") && !inMath) return match;
      // A line break after a carriage return is a real Windows line end, not the `\n` of a command.
      if (letter === "n" && whole[offset - 1] === "\r") return match;
      const guarded = GUARDED.has(name) || letter === "n";
      if (guarded && !inMath) return match;
      if (inMath && (letter === "n" || letter === "t") && textBreak(whole, offset, offset + name.length, name, true)) return match;
      return `\\${name}`;
    });
  }
  return out;
}

/** `repairLatexEscapes` on the prose of a Markdown string; fenced and inline code stays as written. */
export function repairLatexOutsideCode(text: string): string {
  return mapOutsideCode(text, (chunk, start) =>
    repairLatexEscapes(chunk, start === 0 || text[start - 1] === "\n"),
  );
}

/** The value with every string in it repaired by `repairLatexOutsideCode`. */
export function repairModelStrings<T>(value: T): T {
  if (typeof value === "string") {
    // No model indents the first line of a string, so a tab that opens one before a command name is that command, although
    // the parser would read the line as indented code because of the tab.
    const opening = /^\t([A-Za-z]+)(?![A-Za-z])/.exec(value)?.[1];
    const text = opening && BY_LETTER.t!.includes(`t${opening}`) ? `\\t${value.slice(1)}` : value;
    return repairLatexOutsideCode(text) as T;
  }
  if (Array.isArray(value)) return value.map(repairModelStrings) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairModelStrings(item)]),
    ) as T;
  return value;
}
