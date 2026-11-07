/**
 * Adds the comma-separated items in `text` to `current`, as a tags field does on Enter, a comma or a paste. Each item is
 * trimmed and cut to `maxLength`; empty items and repeats (in any case) are dropped, and nothing is added past `max`.
 */
export function addTags(
  current: readonly string[],
  text: string,
  limits: { max: number; maxLength: number },
): string[] {
  const next = [...current];
  const seen = new Set(current.map((item) => item.toLocaleLowerCase()));
  for (const part of text.split(",")) {
    const item = part.trim().slice(0, limits.maxLength).trim();
    if (!item || seen.has(item.toLocaleLowerCase())) continue;
    if (next.length >= limits.max) break;
    next.push(item);
    seen.add(item.toLocaleLowerCase());
  }
  return next;
}
