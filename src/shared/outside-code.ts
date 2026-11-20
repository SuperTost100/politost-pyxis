import { end, parseMarkdown, start, walk } from "./markdown-tree";

/**
 * Where the code of a Markdown text is, as the parser reads it: fenced and indented blocks, with the line end after
 * them, and code spans. A fence inside a longer one, a backtick inside a formula or a fence after a line with a dollar
 * sign, and an indented block after a quote or list marker, are what the parser says they are, not what a scan for
 * backticks or for indented lines would guess. Every text is parsed: no line-based shortcut can tell where code is.
 */
export function codeRanges(input: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  walk(parseMarkdown(input), (node) => {
    if (node.type === "inlineCode") ranges.push([start(node), end(node)]);
    else if (node.type === "code") {
      let to = end(node);
      if (input[to] === "\r" && input[to + 1] === "\n") to += 2;
      else if (input[to] === "\n") to += 1;
      ranges.push([start(node), to]);
    } else return;
    return false;
  });
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Applies `map` to Markdown outside code blocks and code spans. `map` also gets the chunk's `start` and `end` offsets in
 * `input`, for callers that must know whether a chunk edge is a real line edge.
 */
export function mapOutsideCode(
  input: string,
  map: (text: string, start: number, end: number) => string,
): string {
  let out = "";
  let prose = 0;
  for (const [from, to] of codeRanges(input)) {
    if (from > prose) out += map(input.slice(prose, from), prose, from);
    out += input.slice(from, to);
    prose = to;
  }
  if (input.length > prose) out += map(input.slice(prose), prose, input.length);
  return out;
}
