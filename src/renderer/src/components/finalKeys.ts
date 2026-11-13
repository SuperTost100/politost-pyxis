// The keys that answer the final question of a lesson part: A, B, C and D pick an option, and the arrows move between
// the options. The rules live here, free of the page, so a unit test checks them.

/** What the rules read of an element: only its tag and `closest`, so a test can stand in for a real one. */
type Focused = { tagName: string; closest(selector: string): unknown } | null;

/** Where a letter types or acts on something else: controls, text fields, menus and dialogs, the selection menu. */
const ELSEWHERE =
  "a[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable='false']), [role=menu], [role=menuitem], [role=dialog], .px-selection-menu";

/** The option a letter picks, 0 for A, or null for any other key and a letter past the last option. */
export function letterIndex(key: string, options: number): number | null {
  if (key.length !== 1) return null;
  const index = key.toLowerCase().charCodeAt(0) - 97;
  return index >= 0 && index < Math.min(options, 26) ? index : null;
}

/**
 * Whether a letter pressed while `focused` has the focus answers the question: with the focus on the page itself, inside
 * the question, or on something in the sheet that takes no keys of its own (the part's title after Continua). Never in
 * a text field, on another control, in a menu or a dialog, or in the selection menu.
 */
export function letterKeysHere(focused: Focused, inQuestion: boolean): boolean {
  if (!focused || focused.tagName === "BODY" || focused.tagName === "HTML") return true;
  if (inQuestion) return true;
  if (focused.closest(ELSEWHERE)) return false;
  return Boolean(focused.closest(".px-reader-column"));
}

/** The option the arrows move to from `current`, wrapping at both ends; null for any other key. */
export function arrowTarget(key: string, current: number, options: number): number | null {
  if (options < 1) return null;
  if (key === "ArrowDown") return (current + 1) % options;
  if (key === "ArrowUp") return (current - 1 + options) % options;
  return null;
}

/**
 * The question a letter answers: the one whose options have the focus (`focused`), and nothing when that one is
 * answered already, since an answer cannot change; from anywhere else on the page, the first question still open.
 */
export function letterQuestion(
  questions: readonly string[],
  answered: (id: string) => boolean,
  focused: string | null,
): string | null {
  if (focused !== null && questions.includes(focused)) return answered(focused) ? null : focused;
  return questions.find((id) => !answered(id)) ?? null;
}
