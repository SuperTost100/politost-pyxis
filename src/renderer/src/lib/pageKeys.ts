/**
 * The surfaces that own the keyboard while the focus is inside them: a dialog, a menu, the Attività list, a drawer, a
 * dropdown. A study page's own shortcuts (Space and the ratings of the flashcards, the number keys of a quiz) do
 * nothing there, so a key pressed in a panel never acts on the page under it.
 */
const OPEN_SURFACE =
  "[role=dialog], [role=alertdialog], [role=menu], .px-item-menu, .px-jobs, .ant-drawer, .ant-dropdown, .ant-select-dropdown";

/** An element, or what a test stands in for one with: only `closest` is read. */
type Target = { closest(selector: string): unknown } | null | undefined;

/** Whether the key was pressed inside an open surface, so the page's shortcuts leave it alone. */
export function focusInOpenSurface(target: Target): boolean {
  return Boolean(target?.closest(OPEN_SURFACE));
}
