/** Turns \\( … \\) and \\[ … \\] into $ / $$ forms for remark-math. Leaves $ and $$ untouched. */
export function normalizeMathDelimiters(input: string): string {
  let out = input.replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `$$${body}$$`);
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`);
  return out;
}
