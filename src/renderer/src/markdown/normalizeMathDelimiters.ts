function fenceClose(input: string, from: number, tick: string, width: number): number {
  let at = from;
  while (at < input.length) {
    const line = input.indexOf("\n", at);
    const start = line === -1 ? input.length : line + 1;
    let widthHere = 0;
    while (input[start + widthHere] === tick) widthHere += 1;
    if (widthHere >= width) {
      let cursor = start + widthHere;
      while (input[cursor] === " " || input[cursor] === "\t") cursor += 1;
      if (input[cursor] === "\n" || input[cursor] === undefined) {
        return input[cursor] === "\n" ? cursor + 1 : input.length;
      }
    }
    if (line === -1) return -1;
    at = line + 1;
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

/** Applies `map` to Markdown outside fenced blocks and inline code. */
export function mapOutsideCode(
  input: string,
  map: (text: string) => string,
): string {
  let out = "";
  let i = 0;
  let prose = 0;
  const flush = (end: number) => {
    if (end > prose) out += map(input.slice(prose, end));
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
        out += input.slice(i, end);
        i = end;
        prose = end;
        continue;
      }
    }
    if (tick === "`") {
      let width = 0;
      while (input[i + width] === "`") width += 1;
      const close = inlineClose(input, i + width, width);
      if (close !== -1) {
        flush(i);
        out += input.slice(i, close);
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

/** Turns \\( … \\) and \\[ … \\] into $ / $$ forms for remark-math. Leaves $ and $$ untouched. */
export function normalizeMathDelimiters(input: string): string {
  return mapOutsideCode(input, (text) => {
    let out = text.replace(
      /\\\[([\s\S]*?)\\\]/g,
      (_, body: string) => `\n$$\n${body.trim()}\n$$\n`,
    );
    out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`);
    return out;
  });
}
