/**
 * True when `index` is inside a `$...$`, `$$...$$`, `\(...\)` or `\[...\]` span that is not closed yet. An escaped dollar
 * sign is not a delimiter.
 */
export function insideMath(text: string, index: number): boolean {
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
