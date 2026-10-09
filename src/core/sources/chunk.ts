/**
 * SRC-20: section-local chunks with one-sentence overlap and intact math/code. Inline $…$ math stays within one
 * paragraph and 400 characters, so dollar amounts far apart ("costs $5" … "$7") do not join into one unsplittable span.
 */
export function chunkText(text: string, maxChars = 1400): Array<{ text: string; start: number; end: number }> {
  const protectedRanges = [...text.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|(?<!\\)\$(?!\$)(?:[^$\n]|\n(?!\n)){1,400}?(?<!\\)\$/g)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const inside = (n: number) => protectedRanges.some((range) => n > range.start && n < range.end);
  const ends = [...text.matchAll(/(?<=[.!?])\s+|\n{2,}/g)]
    .map((match) => match.index + match[0].length).filter((n) => !inside(n));
  ends.push(text.length);
  const pieces: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const end of ends) {
    while (end - start > maxChars) {
      let cut = start + maxChars;
      while (cut > start && (!/\s/.test(text[cut] ?? "") || inside(cut))) cut -= 1;
      if (cut <= start) {
        cut = start + maxChars;
        while (cut < end && (!/\s/.test(text[cut] ?? "") || inside(cut))) cut += 1;
      }
      pieces.push({ start, end: cut });
      start = cut;
    }
    if (end > start) pieces.push({ start, end });
    start = end;
  }
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let first = 0;
  while (first < pieces.length) {
    let last = first;
    while (last + 1 < pieces.length && pieces[last + 1]!.end - pieces[first]!.start <= maxChars) last += 1;
    const a = pieces[first]!.start;
    const b = pieces[last]!.end;
    const body = text.slice(a, b);
    if (body.trim()) {
      const value = body.trim();
      const start = a + body.indexOf(value);
      chunks.push({ text: value, start, end: start + value.length });
    }
    // Overlap the final sentence only when it still leaves room for the next one.
    first = last > first && last + 1 < pieces.length && pieces[last + 1]!.end - pieces[last]!.start <= maxChars ? last : last + 1;
  }
  return chunks;
}
