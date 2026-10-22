/**
 * A title as a file name every system accepts. Characters Windows refuses and control characters become spaces, runs of
 * space become one, and the name is cut at `max` characters, counted so an emoji is never split. An empty result is
 * `fallback`.
 */
export function safeFileName(title: string, fallback: string, max = 100): string {
  const name = [
    ...title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, max)
    .join("")
    .trim();
  return name || fallback;
}
