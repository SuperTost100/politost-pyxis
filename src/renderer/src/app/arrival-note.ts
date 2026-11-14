import { pageOf } from "./trail";

/**
 * A word for the page a way back is about to open, which that page reads once on arrival (`takeArrivalNote`): what a
 * navigation's `state` would carry, except that going back through the window's history cannot carry one.
 *
 * The note belongs to its destination page, not to "the next navigation": a page left through its way back can make
 * other moves of its own on the way (a redirect that follows the same delete), and the window's history move can come
 * late, so two navigations may finish before the destination has drawn itself. The note stays until the destination
 * takes it, and ends when the router finishes a navigation at a page that is neither the destination nor the page the
 * note was left from, because the student has moved on and the note must not reach a later visit.
 */
let note: { value: unknown; to: string; from: string } | null = null;

/** Leaves a note for the page at `to`, from the page at `from` (the one the student is leaving). */
export function noteForArrival(to: string, from: string, value: unknown): void {
  note = { value, to: pageOf(to), from: pageOf(from) };
}

/** The router finished a navigation at `path`: a note for somewhere else than here and where it came from ends. */
export function arrivedAt(path: string): void {
  if (!note) return;
  const page = pageOf(path);
  if (page !== note.to && page !== note.from) note = null;
}

/** The note left for `page`, once; undefined when there is none, or it was left for another page. */
export function takeArrivalNote<T>(page: string): T | undefined {
  if (!note || note.to !== pageOf(page)) return undefined;
  const { value } = note;
  note = null;
  return value as T;
}
