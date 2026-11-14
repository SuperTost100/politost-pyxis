/**
 * The focus rules of the one dialog (`Dialog.tsx`), kept apart from the DOM so they can be tested. Each takes what the
 * dialog found on the page and returns what to do.
 */

/** What a focusable thing in a dialog is: a field, Annulla, a button that destroys nothing, a destructive one, or the X. */
export type FocusRole = "field" | "cancel" | "action" | "danger" | "close";

/**
 * Where the focus goes as a dialog opens: `initial` when the page names one, else the first field, else Annulla, else
 * the first button that destroys nothing, else the X. Never a destructive button: with nothing else, null, and the dialog
 * itself takes the focus.
 */
export function openingFocus<T>(initial: T | null, candidates: Array<{ node: T; role: FocusRole }>): T | null {
  if (initial !== null) return initial;
  for (const role of ["field", "cancel", "action", "close"] as const) {
    const found = candidates.find((candidate) => candidate.role === role);
    if (found) return found.node;
  }
  return null;
}

/**
 * Tab inside a dialog with `stops` focusable things, the focus on the one at `at` (-1: on none of them, as on the dialog
 * itself). Returns the stop to focus when the key must wrap round, or null when the browser's own move stays inside.
 */
export function wrapTab(stops: number, at: number, back: boolean): number | null {
  if (stops === 0) return null;
  if (at === -1) return back ? stops - 1 : 0;
  if (back && at === 0) return stops - 1;
  if (!back && at === stops - 1) return 0;
  return null;
}

/**
 * Where the focus goes back once the dialog has closed: the first of `choices` still on the page (where the page asked,
 * what it grew out of, what had the focus before it opened). Nothing, when something else has taken the focus meanwhile,
 * such as a dialog that opened over this one: `free` says the focus is still in the closed dialog, on the page's body, or
 * where the browser put it back by itself.
 */
export function closingFocus<T>(
  choices: Array<T | null | undefined>,
  onPage: (node: T) => boolean,
  free: boolean,
): T | null {
  if (!free) return null;
  return choices.find((node): node is T => node !== null && node !== undefined && onPage(node)) ?? null;
}

/** A click outside a dialog closes it like Annulla, unless it is busy or one of its text fields holds typed text. */
export function outsideClickCloses(typed: string[], busy: boolean): boolean {
  return !busy && typed.every((value) => value.trim() === "");
}

/**
 * Where the focus goes when the student stays on a page they tried to leave. A click on a link or a button (the sidebar,
 * the back control) moves the focus onto it before the page asks, so then it goes back to what had it before the click;
 * from the keyboard it stays where it is.
 */
export function stayingFocus<T>(active: T | null, previous: T | null, clicked: boolean): T | null {
  return clicked && previous !== null ? previous : active;
}
