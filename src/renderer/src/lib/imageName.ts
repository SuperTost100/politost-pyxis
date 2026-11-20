/**
 * The file name a picture is saved under: its caption in lowercase words joined by hyphens and cut at a word, or
 * `fallback` when the caption has no letters or digits. A name never carries a path or a character a system refuses.
 */
export function imageFileName(caption: string, fallback: string): string {
  const words = caption
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let name = "";
  for (const word of words) {
    const next = name ? `${name}-${word}` : word;
    if (next.length > 60) break;
    name = next;
  }
  return `${name || fallback}.png`;
}
