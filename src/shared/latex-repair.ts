import { insideMath } from "./inside-math";
import { mapOutsideCode } from "./outside-code";

/**
 * A model that writes LaTeX with one backslash inside a JSON string loses it: `\theta` becomes a tab and "heta", `\frac` a
 * form feed and "rac", `\nu` a line break and "u". `parseLooseJson` fixes the JSON text before it is read; these functions
 * put the backslash back in strings that were already read, as the engine's parser left them.
 *
 * Only text that travelled inside a JSON string can have lost a backslash, so `repairModelStrings` runs on that text alone,
 * once, where the JSON is read: a structured answer (`generate`), a lesson block and its figure's caption (`parseSmartText`,
 * `parseFigure`), a chat question or chart (`chat-blocks`), a tool's arguments (`tools/server`), an introduction sent as
 * JSON and a part's takeaway. Markdown a model wrote as text, and what a student or a book wrote, lost nothing: a tab or a
 * line break in it is one, and nothing repairs it, when it is drawn or ever.
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
// The commands whose name is n and one letter: without the backslash, what is left (e, u, i) can be a variable.
const ONE_LETTER = new Set(["ne", "nu", "ni"]);
const CONTROL: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** Where a row of a display formula begins: after its opening `$$` or `\[`, a `\\` row break or a `\begin{…}` and its arguments. */
const ROW_START = /(?:\$\$|\\\[|(?<!\\)\\\\|\\begin\{[^{}]*\}(?:\{[^{}]*\})*)$/;

/**
 * Whether the n at `at` (a line break, or with `written` a backslash and an n written out), followed by the rest of the
 * name `name` up to `end`, is a line break inside a formula although `\name` is a LaTeX command too. It can be only when
 * what is left of the name is one letter that can be a variable: `\ne` leaves e, `\nu` u, `\ni` i. Then:
 * - `\ne` or `\ni` with nothing on its left in its row of a display formula and an exponent or an index right after it is
 *   no relation, so it is e or i: `$$` and a line break before `e^{-st}` is `e^{-st}`. With something on its left,
 *   `A \ne_{p} B` is the relation with an index.
 * - A line break where a formula laid out on lines has a line end is a line break: right after its opening `$$` or `\[`
 *   when its closing delimiter starts a line too, right after a `\\` row break, or right after `\begin{…}`.
 * A backslash and an n written out, as a structured answer that escaped its line breaks twice has them, is a real command
 * far more often than such a line break, so only the first rule applies to it.
 */
function lineBreakInFormula(text: string, at: number, end: number, name: string, written: boolean): boolean {
  if (!ONE_LETTER.has(name)) return false;
  if (name !== "nu" && /[\^_]/.test(text[end] ?? "") && ROW_START.test(text.slice(0, at).trimEnd())) return true;
  if (written) return false;
  const line = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
  if (/(?<!\\)\\\\$|\\begin\{[^{}]*\}(?:\{[^{}]*\})*$/.test(line)) return true;
  const open = /(\$\$|\\\[)[ \t]*$/.exec(line)?.[1];
  if (!open) return false;
  const close = text.indexOf(open === "$$" ? "$$" : "\\]", at + 1);
  // A formula still being written is laid out as it began.
  return close < 0 || /\n[ \t>]*$/.test(text.slice(at, close));
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
    // The name first: finding the formula reads the text from its start, which ordinary text must not pay for every line.
    if (!AFTER_N.has(name)) return `\n${tail}`;
    const inMath = insideMath(whole, offset);
    const command = inMath || tail.length > 1;
    return command && !(inMath && lineBreakInFormula(whole, offset, offset + match.length, name, true)) ? match : `\n${tail}`;
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
      if (letter === "n" && inMath && lineBreakInFormula(whole, offset, offset + name.length, name, false)) return match;
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

/**
 * The value with every string in it repaired by `repairLatexOutsideCode`, for a value read from a model's JSON: the
 * commands a single backslash lost, a line break written as `\n` and a backslash written twice. Never for other text.
 */
export function repairModelStrings<T>(value: T): T {
  if (typeof value === "string") return repairLatexOutsideCode(value) as T;
  if (Array.isArray(value)) return value.map(repairModelStrings) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairModelStrings(item)]),
    ) as T;
  return value;
}
