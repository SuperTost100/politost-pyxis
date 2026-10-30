import { mathSpans, resolveBookRefs } from "./math-delimiters";

/** The first line that is prose: display formulas (whole `$$ … $$` blocks) and comments are skipped. */
function firstTextLine(raw: string): string {
  let inDisplay = false;
  for (const part of raw.split("\n")) {
    const line = part.trim();
    if (inDisplay) {
      if (line.endsWith("$$")) inDisplay = false;
      continue;
    }
    if (line.startsWith("$$")) {
      // One line, "$$x$$", opens and closes itself.
      inDisplay = !(line.length > 2 && line.endsWith("$$"));
      continue;
    }
    if (line !== "" && !line.startsWith("<!--")) return line;
  }
  return "";
}

/**
 * The first lines of a book paragraph as a short title for a topic's subtopic list. A paragraph's stored text is raw book
 * Markdown, so the title drops the paragraph id (`p2`), the heading marks, emphasis and the `[text](ref:…)` links, keeps
 * `$…$` formulas for the renderer, and is cut at a word, never inside a formula. Running it on its own output changes
 * nothing, so plans saved before it existed read the same way.
 */
export function topicTitle(raw: string, max = 90): string {
  const line = firstTextLine(raw.replace(/^p\d+\s+(?=\S)/, ""));
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
