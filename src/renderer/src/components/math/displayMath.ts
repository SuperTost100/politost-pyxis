import { parseMathText, type MathSegment } from "./mathString";

const MATH_COMMANDS = new Set([
  "frac", "dfrac", "tfrac", "sqrt", "int", "iint", "iiint", "oint", "sum", "prod", "lim",
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "ln", "log", "exp", "det", "deg", "gcd", "max", "min", "sup", "inf", "arg", "Re", "Im",
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma",
  "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "infty", "partial", "nabla", "cdot", "cdots", "ldots", "dots", "times", "div", "pm", "mp",
  "le", "leq", "ge", "geq", "ne", "neq", "approx", "equiv", "sim", "simeq", "cong", "propto",
  "to", "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow", "Leftrightarrow", "iff", "mapsto",
  "in", "notin", "subset", "subseteq", "supset", "supseteq", "cup", "cap", "setminus", "emptyset", "varnothing",
  "forall", "exists", "neg", "land", "lor", "implies",
  "mathbb", "mathcal", "mathrm", "mathbf", "mathit", "mathsf", "text", "operatorname",
  "vec", "hat", "bar", "tilde", "overline", "underline", "dot", "ddot", "binom",
  "left", "right", "bigl", "bigr", "Bigl", "Bigr", "quad", "qquad",
]);

const DIFF_OR_FUNC = /^(?:sin|cos|tan|cot|sec|csc|ln|log|exp|lim|dx|dy|dz|dt|du|dv|dr|ds)(?![A-Za-zÀ-ÿ])/;

function readBalanced(text: string, at: number, open: string, close: string): number {
  if (text[at] !== open) return -1;
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === open) depth += 1;
    else if (text[i] === close && (depth -= 1) === 0) return i + 1;
  }
  return -1;
}

function readBalancedBackward(text: string, endExclusive: number, open: string, close: string): number {
  const last = endExclusive - 1;
  if (last < 0 || text[last] !== close) return -1;
  let depth = 0;
  for (let i = last; i >= 0; i -= 1) {
    if (text[i] === close) depth += 1;
    else if (text[i] === open && (depth -= 1) === 0) return i;
  }
  return -1;
}

function readCommand(text: string, at: number): { name: string; end: number } | null {
  if (text[at] !== "\\") return null;
  if (at > 0 && text[at - 1] === "\\") return null;
  const match = /^\\([A-Za-z]+|,|;|!|:)/.exec(text.slice(at));
  if (!match) return null;
  const name = match[1]!;
  if (name.length > 1 && !MATH_COMMANDS.has(name)) return null;
  if (name.length === 1 && !/[,;!:]/.test(name)) return null;
  let end = at + match[0].length;
  // Consume optional [...] and braced {...} arguments belonging to the command (e.g. \sqrt[3]{x}, \frac{1}{2}).
  if (name === "sqrt" && text[end] === "[") {
    const bracketEnd = readBalanced(text, end, "[", "]");
    if (bracketEnd > end) end = bracketEnd;
  }
  while (text[end] === "{") {
    const braceEnd = readBalanced(text, end, "{", "}");
    if (braceEnd < 0) break;
    end = braceEnd;
  }
  return { name, end };
}

/** Reads one math atom starting at `at` (no leading whitespace). Returns its end offset or -1. */
function readAtomForward(text: string, at: number): number {
  if (at >= text.length) return -1;
  const ch = text[at]!;
  if (ch === "\\") {
    const cmd = readCommand(text, at);
    return cmd ? cmd.end : -1;
  }
  if (ch === "(") return readBalanced(text, at, "(", ")");
  if (ch === "[") return readBalanced(text, at, "[", "]");
  if (ch === "{") return readBalanced(text, at, "{", "}");
  const num = /^\d+(?:[.,]\d+)?/.exec(text.slice(at));
  if (num) return at + num[0].length;
  const fn = DIFF_OR_FUNC.exec(text.slice(at));
  if (fn) return at + fn[0].length;
  // A single Latin letter not followed by another letter (so prose words like "converge" or "con" never match).
  if (/[A-Za-z]/.test(ch) && !/[A-Za-zÀ-ÿ]/.test(text[at + 1] ?? "")) return at + 1;
  return -1;
}

/** Reads scripts (^... / _...) and immediate juxtaposed atoms (e.g. 2a_{n}, x^{2}, f(x)) starting at `at`. */
function readTermForward(text: string, at: number): number {
  let pos = readAtomForward(text, at);
  if (pos < 0) return -1;
  for (;;) {
    // Superscript or subscript attached to the term.
    if ((text[pos] === "^" || text[pos] === "_") && pos + 1 < text.length) {
      if (text[pos + 1] === "{") {
        const end = readBalanced(text, pos + 1, "{", "}");
        if (end > pos) {
          pos = end;
          continue;
        }
      } else if (text[pos] === "^" && /^-?[0-9A-Za-z]/.test(text.slice(pos + 1))) {
        const m = /^-?[0-9A-Za-z]/.exec(text.slice(pos + 1))!;
        pos += 1 + m[0].length;
        continue;
      } else if (text[pos] === "_" && /^[0-9A-Za-z](?![A-Za-zÀ-ÿ])/.test(text.slice(pos + 1))) {
        pos += 2;
        continue;
      }
    }
    // Prime marks like y'(x) or f''.
    if (text[pos] === "'") {
      pos += 1;
      continue;
    }
    // Juxtaposed factor without whitespace: 2x, x(t), \frac{1}{2}x^{2}, \alpha\beta, x\,dx.
    const next = readAtomForward(text, pos);
    if (next > pos) {
      pos = next;
      continue;
    }
    break;
  }
  return pos;
}

const BINARY_OP = /^(?:[+\-*/=<>]|\\(?:pm|mp|cdot|times|div|le|leq|ge|geq|ne|neq|approx|equiv|sim|to|rightarrow|leftarrow|Rightarrow|Leftarrow|iff|in|notin|subset|subseteq|cup|cap)\b)/;

/** Expands rightward across binary operators and math terms from `pos`. */
function expandRight(text: string, startPos: number): number {
  let pos = startPos;
  for (;;) {
    // Continue any scripts/juxtaposed factors attached directly at `pos`.
    if ((text[pos] === "^" || text[pos] === "_") && pos + 1 < text.length) {
      const next = readTermForward(text, pos - 1);
      if (next > pos) {
        pos = next;
        continue;
      }
    }
    const direct = readTermForward(text, pos);
    if (direct > pos) {
      pos = direct;
      continue;
    }
    // Optional spaces + binary operator + optional spaces + unary sign? + math term.
    let scan = pos;
    while (text[scan] === " ") scan += 1;
    const op = BINARY_OP.exec(text.slice(scan));
    if (!op) break;
    scan += op[0].length;
    while (text[scan] === " ") scan += 1;
    if (text[scan] === "+" || text[scan] === "-") {
      scan += 1;
      while (text[scan] === " ") scan += 1;
    }
    const rhs = readTermForward(text, scan);
    if (rhs < 0) break;
    pos = rhs;
  }
  return pos;
}

/** Reads one math term immediately ending at `end` (no trailing spaces). Returns its start offset or -1. */
function readTermBackward(text: string, end: number, floor: number): number {
  let pos = end;
  let moved = false;
  while (pos > floor) {
    // Trailing prime.
    if (text[pos - 1] === "'") {
      pos -= 1;
      moved = true;
      continue;
    }
    // Balanced group (...) or {...} or [...].
    if (text[pos - 1] === ")" || text[pos - 1] === "}" || text[pos - 1] === "]") {
      const close = text[pos - 1]!;
      const open = close === ")" ? "(" : close === "}" ? "{" : "[";
      const start = readBalancedBackward(text, pos, open, close);
      if (start < floor) break;
      pos = start;
      moved = true;
      // If preceded by ^ or _ or a LaTeX command name, keep pulling that in.
      if (pos > floor && (text[pos - 1] === "^" || text[pos - 1] === "_")) {
        pos -= 1;
        continue;
      }
      const cmdMatch = /\\([A-Za-z]+)$/.exec(text.slice(floor, pos));
      if (cmdMatch && MATH_COMMANDS.has(cmdMatch[1]!)) {
        pos -= cmdMatch[0].length;
      }
      continue;
    }
    // Preceding LaTeX command without braces (e.g. \alpha, \pi).
    const cmd = /\\([A-Za-z]+)$/.exec(text.slice(floor, pos));
    if (cmd && MATH_COMMANDS.has(cmd[1]!)) {
      pos -= cmd[0].length;
      moved = true;
      continue;
    }
    // Number immediately attached.
    const num = /\d+(?:[.,]\d+)?$/.exec(text.slice(floor, pos));
    if (num) {
      const start = pos - num[0].length;
      if (start === floor || !/[A-Za-zÀ-ÿ_]/.test(text[start - 1]!)) {
        pos = start;
        moved = true;
        continue;
      }
    }
    // Single letter not preceded by another letter (never swallows a prose word like "con").
    if (/[A-Za-z]/.test(text[pos - 1]!) && (pos - 1 === floor || !/[A-Za-zÀ-ÿ]/.test(text[pos - 2]!))) {
      pos -= 1;
      moved = true;
      continue;
    }
    break;
  }
  return moved ? pos : -1;
}

/** Expands leftward across unary/binary operators and math terms from `pos`. */
function expandLeft(text: string, startPos: number, floor: number): number {
  let pos = startPos;
  // Pull in the immediate base of the trigger (e.g. `x` before `^{2}`, `2x` before `^{2}`).
  const base = readTermBackward(text, pos, floor);
  if (base >= floor) pos = base;
  for (;;) {
    let scan = pos;
    while (scan > floor && text[scan - 1] === " ") scan -= 1;
    // Unary minus directly attached to the start of the formula (e.g. `-x^{2}`).
    if (scan > floor && (text[scan - 1] === "-" || text[scan - 1] === "+")) {
      const beforeSign = scan - 1;
      if (beforeSign === floor || /[\s([=]/.test(text[beforeSign - 1]!)) {
        pos = beforeSign;
        continue;
      }
    }
    // Binary operator before `pos`: e.g. `y = ` or `a + `.
    const opMatch = /(?:[+\-*/=<>]|\\(?:pm|mp|cdot|times|div|le|leq|ge|geq|ne|neq|approx|equiv|sim|to|rightarrow|leftarrow|Rightarrow|Leftarrow|iff))$/.exec(
      text.slice(floor, scan),
    );
    if (!opMatch) break;
    let beforeOp = scan - opMatch[0].length;
    while (beforeOp > floor && text[beforeOp - 1] === " ") beforeOp -= 1;
    const lhs = readTermBackward(text, beforeOp, floor);
    if (lhs < floor) break;
    pos = lhs;
  }
  return pos;
}

/** Finds unambiguous bare LaTeX spans in a plain text segment. */
function splitBareLatex(text: string): MathSegment[] {
  const urls = [...text.matchAll(/https?:\/\/\S+/g)].map((m) => [m.index, m.index + m[0].length] as const);
  const inUrl = (at: number) => urls.some(([from, to]) => at >= from && at < to);

  const ranges: Array<[number, number]> = [];
  let floor = 0;
  let i = 0;
  while (i < text.length) {
    if (inUrl(i)) {
      i += 1;
      continue;
    }
    let triggerEnd = -1;
    let triggerStart = i;

    if (text[i] === "\\") {
      const cmd = readCommand(text, i);
      if (cmd && cmd.name.length > 1) {
        triggerEnd = cmd.end;
      }
    } else if ((text[i] === "^" || text[i] === "_") && text[i + 1] === "{") {
      const end = readBalanced(text, i + 1, "{", "}");
      if (end > i + 2) {
        triggerEnd = end;
      }
    } else if (text[i] === "^" && /^-?[0-9A-Za-z]/.test(text.slice(i + 1))) {
      // Single-token caret power like x^2 or (x+1)^2, not inside a word like foo^bar.
      const prev = text[i - 1] ?? "";
      const prev2 = text[i - 2] ?? "";
      const validBase =
        prev === ")" ||
        prev === "}" ||
        prev === "]" ||
        /\d/.test(prev) ||
        (/[A-Za-z]/.test(prev) && !/[A-Za-zÀ-ÿ]/.test(prev2));
      if (validBase) {
        const m = /^-?[0-9A-Za-z]/.exec(text.slice(i + 1))!;
        triggerEnd = i + 1 + m[0].length;
      }
    }

    if (triggerEnd < 0) {
      i += 1;
      continue;
    }

    // Never cross a line break when expanding a bare inline expression.
    const lineStart = Math.max(floor, text.lastIndexOf("\n", triggerStart) + 1);
    const lineEndRaw = text.indexOf("\n", triggerEnd);
    const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
    const line = text.slice(lineStart, lineEnd);

    const relStart = expandLeft(line, triggerStart - lineStart, 0);
    const relEnd = expandRight(line, triggerEnd - lineStart);
    const absStart = lineStart + relStart;
    const absEnd = lineStart + relEnd;
    if (absEnd > absStart) {
      ranges.push([absStart, absEnd]);
      floor = absEnd;
      i = absEnd;
    } else {
      i = triggerEnd;
    }
  }

  if (ranges.length === 0) return text ? [{ kind: "text", text }] : [];
  const out: MathSegment[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) out.push({ kind: "text", text: text.slice(at, from) });
    out.push({ kind: "math", latex: text.slice(from, to) });
    at = to;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** Splits `\( ... \)` and `\[ ... \]` pairs out of a text segment. */
function splitLatexDelimiters(text: string): MathSegment[] {
  const out: MathSegment[] = [];
  let at = 0;
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const display = text[i + 1] === "[";
      const close = display ? "\\]" : "\\)";
      const end = text.indexOf(close, i + 2);
      if (end > i + 2) {
        const latex = text.slice(i + 2, end).trim();
        if (latex && (display || !latex.includes("\n"))) {
          if (i > at) out.push({ kind: "text", text: text.slice(at, i) });
          out.push(display ? { kind: "math", latex, display: true } : { kind: "math", latex });
          i = end + 2;
          at = i;
          continue;
        }
      }
    }
    i += 1;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/**
 * Splits a read-only student message or answer into text and formulas: `$...$` / `$$...$$`, `\(...\)` / `\[...\]`,
 * and unambiguous bare LaTeX expressions such as `x^{2}+1` or `\frac{1}{2}`, while leaving plain text untouched.
 */
export function parseDisplayMath(input: string): MathSegment[] {
  const merged: MathSegment[] = [];
  const push = (segment: MathSegment) => {
    const prev = merged.at(-1);
    if (segment.kind === "text" && prev?.kind === "text") prev.text += segment.text;
    else merged.push(segment);
  };
  for (const segment of parseMathText(input)) {
    if (segment.kind === "math") {
      push(segment);
      continue;
    }
    for (const part of splitLatexDelimiters(segment.text)) {
      if (part.kind === "math") push(part);
      else for (const sub of splitBareLatex(part.text)) push(sub);
    }
  }
  return merged;
}
