import { mathSpans, resolveBookRefs } from "./math-delimiters";

/**
 * The first lines of a book paragraph as a short title for a topic's subtopic list. A paragraph's stored text is raw book
 * Markdown, so the title drops the paragraph id (`p2`), the heading marks, emphasis and the `[text](ref:…)` links, keeps
 * `$…$` formulas for the renderer, and is cut at a word, never inside a formula. Running it on its own output changes
 * nothing, so plans saved before it existed read the same way.
 */
export function topicTitle(raw: string, max = 90): string {
  const line =
    raw
      .replace(/^p\d+\s+(?=\S)/, "")
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "" && !/^(?:\$\$|<!--)/.test(part)) ?? "";
  const text = resolveBookRefs(line)
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  // The cut and the ellipsis together stay within max, so a title that was already cut is not cut again.
  const room = max - 1;
  let cut = text.slice(0, room);
  for (const [start, end] of mathSpans(text)) if (start < room && end > room) cut = text.slice(0, start);
  // A cut that lands inside a word goes back to the word before it.
  if (/\S/.test(text[cut.length] ?? " ") && /\S$/.test(cut) && cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" "));
  return `${cut.trimEnd()}…`;
}
