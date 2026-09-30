/** Applies `map` to Markdown outside fenced blocks and inline code. */
export function mapOutsideCode(
  input: string,
  map: (text: string) => string,
): string {
  return input
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : map(part)))
    .join("");
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
