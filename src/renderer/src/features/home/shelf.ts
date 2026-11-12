/** How the Library's shelf draws a file and a subject, kept free of the page so a unit test reads it. */

import { isPdfPasswordError } from "../../../../shared/source-errors";

/** The number of subject cover colours (`--cover-1` to `--cover-6` in tokens.css). */
const COVER_COLOURS = 6;

/** A subject's cover colour, 1 to 6, from its id, so it stays the same for that subject whatever its name or place. */
export function coverColour(subjectId: string): number {
  let hash = 2166136261;
  for (const char of subjectId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % COVER_COLOURS) + 1;
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

/**
 * Whether a group's lines are about some of its files only. A file Pyxis is still choosing for counts as a reason, since
 * the lines for the others must not claim to speak for all of them.
 */
export const mixedReasons = (reasons: ReadonlySet<string>) => reasons.size > 1;

/** The states of a file whose read went wrong, which the student has to look at. */
export const PROBLEM = new Set(["failed", "needs-ocr", "interrupted", "cancelled"]);

type ShelfFile = {
  title: string;
  status: string;
  error?: string | null;
  errorJobId?: string | null;
  linked?: { missing?: boolean } | null;
};

/**
 * How much a file needs the student, most first: its read failed (0), its file is gone from the linked folder (1), it is
 * a PDF waiting for its password (2), it is still being read (3); anything else needs nothing (4).
 */
function need(source: ShelfFile): number {
  if (source.errorJobId && isPdfPasswordError(source.error)) return 2;
  if (PROBLEM.has(source.status)) return 0;
  if (source.linked?.missing) return 1;
  if (source.status !== "ready") return 3;
  return 4;
}

/** Whether a file needs the student: a failed read, a missing file, a password to give, or a read still under way. */
export const needsStudent = (source: ShelfFile) => need(source) < 4;

/**
 * The order of a shelf and of "Da sistemare": the files that need the student first, as `need` ranks them, so none
 * hides behind "Mostra tutti", then by title, numbers in order ("Lezione 2" before "Lezione 10").
 */
export function byShelfOrder(a: ShelfFile, b: ShelfFile): number {
  return need(a) - need(b) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Where a file sits on a shelf once it is read, after the files that need the student, among whatever else the shelf
 * holds. A file still being read sorts first, so its place now says nothing about where it goes when its read ends.
 */
export function placeWhenReady<T extends ShelfFile & { id: string }>(files: readonly T[], file: T): number {
  const ready = { ...file, status: "ready", error: null, errorJobId: null, linked: null };
  return [...files.filter((other) => other.id !== file.id), ready].sort(byShelfOrder).indexOf(ready);
}
