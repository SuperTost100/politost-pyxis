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

/** Wraps LaTeX from the formula field as inline Markdown math. Empty input gives an empty string. */
export function wrapLatex(latex: string): string {
  const body = braceFractions(
    latex
      // The field marks unfilled slots; an unfilled slot has nothing to show.
      .replace(/\\placeholder(?:\[[^\]]*\])?\{[^{}]*\}/g, ""),
  ).trim();
  if (!body) return "";
  // A bare dollar sign would end the span early.
  return `$${body.replace(/(?<!\\)\$/g, "\\$")}$`;
}

/** True when the text holds a closed `$...$` or `$$...$$` span worth previewing. */
export function hasMath(text: string): boolean {
  return /\$\$[\s\S]+?\$\$|(?<!\\)\$[^$\n]+?(?<!\\)\$/.test(text);
}

export type CaretInsert = { value: string; caret: number };

/**
 * Puts `insertion` where the selection is, replacing any selected text.
 * A space goes in only where the neighbouring characters would run into the insertion.
 */
export function insertAtCaret(
  text: string,
  start: number,
  end: number,
  insertion: string,
): CaretInsert {
  const from = Math.min(Math.max(start, 0), text.length);
  if (!insertion) return { value: text, caret: from };
  const to = Math.min(Math.max(end, from), text.length);
  const before = text.slice(0, from);
  const after = text.slice(to);
  const padBefore = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const padAfter = after.length > 0 && /^[\p{L}\p{N}$]/u.test(after) ? " " : "";
  const head = `${before}${padBefore}${insertion}`;
  return { value: `${head}${padAfter}${after}`, caret: head.length };
}
