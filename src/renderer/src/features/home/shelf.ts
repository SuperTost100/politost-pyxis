/** How the Library's shelf draws a file and a subject, kept free of the page so a unit test reads it. */

/** The number of subject cover colours (`--cover-1` to `--cover-6` in tokens.css). */
const COVER_COLOURS = 6;

/** A subject's cover colour, 1 to 6, from its id, so it stays the same for that subject whatever its name or place. */
export function coverColour(subjectId: string): number {
  let hash = 2166136261;
  for (const char of subjectId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % COVER_COLOURS) + 1;
}

/**
 * What a cover draws, from what core records: a free book is a book, a file an exam uses as a past paper an exam paper,
 * a photo a photo, a PowerPoint file slides, and anything else a stack of pages.
 */
export function coverKind(source: { kind: string; pastPaper: boolean }): "book" | "photo" | "exam" | "slides" | "pages" {
  if (source.kind === "smartbook") return "book";
  if (source.pastPaper) return "exam";
  if (source.kind === "image") return "photo";
  if (source.kind === "pptx") return "slides";
  return "pages";
}

/** Words a subject's initials skip, in Italian and English. */
const SMALL_WORDS = new Set([
  "e", "ed", "di", "del", "della", "dello", "dei", "degli", "delle", "per", "con", "in", "a", "da", "il", "lo", "la", "i",
  "gli", "le", "and", "of", "the", "for", "to",
]);

/**
 * What a book cover prints: the subject's name when it fits, or its initials, as a student shortens "Geometria e
 * algebra lineare" to "GAL". A number in the name stays a number ("Analisi matematica 2" is "AM2").
 */
export function bookLabel(name: string): string {
  const clean = name.trim();
  if (clean.length <= 12) return clean;
  const words = clean
    .split(/\s+/)
    .map((word) => word.replace(/^.*['’]/, "").replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word && !SMALL_WORDS.has(word.toLocaleLowerCase()));
  const initials = words.map((word) => (/^\p{N}+$/u.test(word) ? word : word[0]!.toLocaleUpperCase())).join("");
  return initials.length >= 2 ? initials.slice(0, 5) : clean.slice(0, 12);
}
