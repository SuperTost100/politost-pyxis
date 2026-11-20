/** Where the block opened by a fence ends: just after the first line from `from` on that closes it, or -1. */
function fenceClose(input: string, from: number, tick: string, width: number): number {
  // `from` is the start of the first line after the opening fence, and that line may already be the closing one.
  let start = from;
  while (start <= input.length) {
    let widthHere = 0;
    while (input[start + widthHere] === tick) widthHere += 1;
    if (widthHere >= width) {
      let cursor = start + widthHere;
      while (input[cursor] === " " || input[cursor] === "\t") cursor += 1;
      // A line ends in LF or CRLF; the opening fence is found by its LF, so it needs no such care.
      const lineEnd = input[cursor] === "\r" && input[cursor + 1] === "\n" ? 2 : input[cursor] === "\n" ? 1 : 0;
      if (lineEnd > 0) return cursor + lineEnd;
      if (input[cursor] === undefined) return input.length;
    }
    const line = input.indexOf("\n", start);
    if (line === -1) return -1;
    start = line + 1;
  }
  return -1;
}

function inlineClose(input: string, from: number, width: number): number {
  const marker = "`".repeat(width);
  let at = from;
  while (at < input.length) {
    const found = input.indexOf(marker, at);
    if (found === -1) return -1;
    if (input[found + width] !== "`") return found + width;
    at = found + 1;
  }
  return -1;
}

/**
 * Where an inline formula opened by the `$` at `from` ends (just after its closing `$` run), or -1 when none closes in its
 * paragraph. A backslash escapes the next character. Inside it, backticks are data: micromark reads whichever of a
 * formula and a code span opens first, so `$\text{`x`}$` is one formula.
 */
function mathClose(input: string, from: number): number {
  let width = 1;
  while (input[from + width] === "$") width += 1;
  let at = from + width;
  while (at < input.length) {
    if (input[at] === "\\") {
      at += 2;
      continue;
    }
    if (input[at] === "\n" && /^\n[ \t]*\n/.test(input.slice(at, at + 40))) return -1;
    if (input[at] === "$") {
      let run = 0;
      while (input[at + run] === "$") run += 1;
      if (run === width) return at + run;
      at += run;
      continue;
    }
    at += 1;
  }
  return -1;
}

/**
 * Applies `map` to Markdown outside fenced blocks and inline code. `map` also gets the chunk's `start` and `end`
 * offsets in `input`, for callers that must know whether a chunk edge is a real line edge.
 */
export function mapOutsideCode(
  input: string,
  map: (text: string, start: number, end: number) => string,
  /** Also maps a code block or span, as written, with its kind. Without it, code is kept as it is. */
  mapCode: (code: string, kind: "fence" | "inline") => string = (code) => code,
): string {
  let out = "";
  let i = 0;
  let prose = 0;
  const flush = (end: number) => {
    if (end > prose) out += map(input.slice(prose, end), prose, end);
    prose = end;
  };
  while (i < input.length) {
    const atLine = i === 0 || input[i - 1] === "\n";
    const tick = input[i];
    if (atLine && (tick === "`" || tick === "~")) {
      let width = 0;
      while (input[i + width] === tick) width += 1;
      if (width >= 3) {
        const lineEnd = input.indexOf("\n", i);
        const close =
          lineEnd === -1
            ? -1
            : fenceClose(input, lineEnd + 1, tick, width);
        flush(i);
        const end = close === -1 ? input.length : close;
        out += mapCode(input.slice(i, end), "fence");
        i = end;
        prose = end;
        continue;
      }
    }
    if (tick === "\\" && input[i + 1] === "$") {
      // An escaped dollar sign opens no formula.
      i += 2;
      continue;
    }
    if (tick === "$") {
      // A formula that closes in its paragraph is prose from its first dollar to its last, backticks inside it included.
      const close = mathClose(input, i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (tick === "`") {
      let width = 0;
      while (input[i + width] === "`") width += 1;
      const close = inlineClose(input, i + width, width);
      if (close !== -1) {
        flush(i);
        out += mapCode(input.slice(i, close), "inline");
        i = close;
        prose = close;
        continue;
      }
    }
    i += 1;
  }
  flush(input.length);
  return out;
}
