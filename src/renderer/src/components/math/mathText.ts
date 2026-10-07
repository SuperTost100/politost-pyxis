/**
 * A message is a string with LaTeX between dollar signs. The editors show it as text with
 * formulas inline, so this file reads that string into segments and writes segments back.
 *
 * Rules, shared by every reader and writer here:
 * - `$...$` is inline math. The opening sign needs a non-space after it, the closing one a
 *   non-space before it, and the span stays on one line. `$$...$$` is display math and may span lines.
 * - In text, `\$` is a literal dollar sign. A run of backslashes right before a dollar sign is
 *   doubled when written, so a backslash typed before a formula survives the round trip.
 * - A dollar sign with no partner stays text, and an empty formula is never written.
 */

export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; latex: string; display?: boolean };

/** Reads one argument at `at`: a braced group or a single token. Returns its content and where it ends. */
function readArgument(text: string, at: number): { body: string; end: number } | null {
  let i = at;
  while (text[i] === " ") i += 1;
  if (text[i] === "{") {
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === "\\") j += 1;
      else if (text[j] === "{") depth += 1;
      else if (text[j] === "}" && (depth -= 1) === 0)
        return { body: text.slice(i + 1, j), end: j + 1 };
    }
    return null;
  }
  const token = /^(?:\\[A-Za-z]+|[0-9A-Za-z])/.exec(text.slice(i));
  return token ? { body: token[0], end: i + token[0].length } : null;
}

/** The field writes `\frac12` for single-character parts; braces read better and survive editing. */
function braceFractions(latex: string): string {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const found = /\\d?frac(?![A-Za-z])/.exec(latex.slice(at));
    if (!found) break;
    const start = at + found.index;
    const afterName = start + found[0].length;
    const top = readArgument(latex, afterName);
    const bottom = top ? readArgument(latex, top.end) : null;
    if (!top || !bottom) {
      out.push(latex.slice(at, afterName));
      at = afterName;
      continue;
    }
    out.push(latex.slice(at, afterName), `{${braceFractions(top.body)}}{${braceFractions(bottom.body)}}`);
    at = bottom.end;
  }
  out.push(latex.slice(at));
  return out.join("");
}

/** Tidies LaTeX from the formula field: no unfilled slots, braced fractions, no edge spaces. */
export function cleanLatex(latex: string): string {
  let body = braceFractions(
    // The field marks unfilled slots; an unfilled slot has nothing to show.
    latex.replace(/\\placeholder(?:\[[^\]]*\])?\{[^{}]*\}/g, ""),
  ).trim();
  // A lone trailing backslash would escape the closing dollar sign.
  const tail = /\\+$/.exec(body)?.[0].length ?? 0;
  if (tail % 2 === 1) body = body.slice(0, -1).trimEnd();
  return body;
}

/** Index of the dollar sign closing inline math that opened before `from`, or -1. */
function inlineClose(input: string, from: number): number {
  for (let i = from; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\n") return -1;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "$") return /\s/.test(input[i - 1] ?? "") ? -1 : i;
  }
  return -1;
}

/** Index of the `$$` closing display math that opened before `from`, or -1. */
function displayClose(input: string, from: number): number {
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === "\\") i += 1;
    else if (input[i] === "$" && input[i + 1] === "$") return i;
  }
  return -1;
}

/** Splits a message into text and formulas. Adjacent text is merged, so segments alternate. */
export function parseMathText(input: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let text = "";
  const flush = () => {
    if (text) segments.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === "\\") {
      let j = i;
      while (input[j] === "\\") j += 1;
      if (input[j] !== "$") {
        text += input.slice(i, j);
        i = j;
        continue;
      }
      const run = j - i;
      text += "\\".repeat(Math.floor(run / 2));
      if (run % 2 === 1) {
        text += "$";
        i = j + 1;
      } else i = j;
      continue;
    }
    if (ch !== "$") {
      text += ch;
      i += 1;
      continue;
    }
    if (input[i + 1] === "$") {
      const close = displayClose(input, i + 2);
      const latex = close < 0 ? "" : input.slice(i + 2, close).trim();
      if (latex) {
        flush();
        segments.push({ kind: "math", latex, display: true });
        i = close + 2;
        continue;
      }
    } else if (input[i + 1] !== undefined && !/\s/.test(input[i + 1]!)) {
      const close = inlineClose(input, i + 1);
      if (close > i + 1) {
        flush();
        segments.push({ kind: "math", latex: input.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    text += "$";
    i += 1;
  }
  flush();
  return segments;
}

/** Doubles the backslashes right before each dollar sign and escapes the sign. */
function escapeText(text: string, beforeMath: boolean): string {
  const escaped = text.replace(/(\\*)\$/g, (_, run: string) => `${run}${run}\\$`);
  return beforeMath ? escaped.replace(/(\\+)$/, "$1$1") : escaped;
}

/** Writes segments back as a message. Empty formulas are dropped. */
export function serializeMathText(segments: readonly MathSegment[]): string {
  const kept = segments.filter((s) => s.kind === "text" || s.latex.trim());
  return kept
    .map((segment, index) => {
      if (segment.kind === "text")
        return escapeText(segment.text, kept[index + 1]?.kind === "math");
      // A bare dollar sign inside the formula would end the span early.
      const latex = segment.latex.trim().replace(/(?<!\\)((?:\\\\)*)\$/g, "$1\\$");
      const fence = segment.display ? "$$" : "$";
      return `${fence}${latex}${fence}`;
    })
    .join("");
}
