import { mapOutsideCode } from "./outside-code";

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
  n: ["nu", "neq", "ne", "nabla", "not", "notin", "ni", "nolimits", "nmid", "ngtr", "nless", "nleq", "ngeq", "nsim", "ncong", "nexists", "nrightarrow", "nleftarrow", "nparallel", "newline", "nonumber", "normalsize"],
  v: ["vec", "vee", "varphi", "varepsilon", "vartheta", "varrho", "varsigma", "varpi", "varkappa", "varnothing", "vdots", "vdash", "vert", "vline", "vspace", "vphantom", "verb"],
};
// A tab or a line break is real text far more often than a form feed, a backspace or a vertical tab is, so these names are
// repaired only inside a `$` span: "\tto" and "\ntop" can start a word.
const GUARDED = new Set(["to", "top", "tag", "tan", "tiny", "ne", "ni", "not", "notin", "nu", "neq", "nolimits", "nmid", "ngtr", "nless", "nleq", "ngeq", "nsim", "ncong", "nexists", "nrightarrow", "nleftarrow", "nparallel", "newline", "nonumber", "normalsize", "nabla"]);
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

const PATTERNS = Object.entries(BY_LETTER).map(([letter, rest]) => ({
  letter,
  pattern: new RegExp(`${CONTROL[letter]}(${rest.map((name) => name.slice(1)).join("|")})(?![A-Za-z])`, "g"),
}));

/**
 * Restores `\beta`, `\frac`, `\nu`, `\right`, `\theta` and `\vec` commands turned into control characters. Real tabs and line breaks stay.
 * `atLineStart` says whether the text begins a line; a chunk that follows inline code does not, so its first tab is not indentation.
 */
export function repairLatexEscapes(text: string, atLineStart = true): string {
  if (!/[\b\f\n\r\t\v]/.test(text)) return text;
  let out = text;
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
  if (typeof value === "string") return repairLatexOutsideCode(value) as T;
  if (Array.isArray(value)) return value.map(repairModelStrings) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairModelStrings(item)]),
    ) as T;
  return value;
}
