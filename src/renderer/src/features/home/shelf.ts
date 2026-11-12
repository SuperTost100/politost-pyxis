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

type SortState = "working" | "stopped" | "created" | "unsure" | "no-ai" | null;

/**
 * The row of "Da sistemare" whose choice takes focus once `movedId` has left it: the nearest row below that has a
 * picker, then the nearest above. A row Pyxis is still choosing for (`working`) shows no picker. Null when none has one,
 * and focus goes to the moved cover.
 */
export function nextPickerRow(rows: { id: string; sort: SortState }[], movedId: string): string | null {
  const at = rows.findIndex((row) => row.id === movedId);
  const hasPicker = (row: { sort: SortState } | undefined) => row !== undefined && row.sort !== "working";
  const below = rows.slice(at + 1).find(hasPicker);
  const above = rows.slice(0, Math.max(at, 0)).reverse().find(hasPicker);
  return (below ?? above)?.id ?? null;
}

/**
 * Why files wait in "Da sistemare", from what core records: `unsure`, `no-ai`, `stopped` and `working` are what
 * happened to a file the Library asked about; `none` is a file it never asked about (a loose file of a linked folder,
 * one from before the sort existed).
 */
export function unsortedReasons(sources: { sort: SortState }[]): Set<"working" | "stopped" | "unsure" | "no-ai" | "none"> {
  return new Set(sources.map((source) => (source.sort === null || source.sort === "created" ? "none" : source.sort)));
}
