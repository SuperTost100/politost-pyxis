/** The part of an element `canTakeFocus` asks about, so a test can pass a plain object. */
export type FocusCandidate = {
  isConnected: boolean;
  closest(selector: string): unknown;
  matches(selector: string): boolean;
  checkVisibility(options?: { visibilityProperty?: boolean; contentVisibilityAuto?: boolean }): boolean;
};

/**
 * Whether the focus can be put on an element now. A button inside a folded row, a closed panel or an inert region is on
 * the page and still cannot take it: `focus()` does nothing, and a return of the focus that took such a button for found
 * would end with the focus on the page's body. `checkVisibility` is the browser's own answer for `display: none`, a
 * collapsed `content-visibility` and, with the option, `visibility: hidden` on the element or any ancestor.
 */
export function canTakeFocus(element: FocusCandidate): boolean {
  return (
    element.isConnected &&
    !element.closest("[inert]") &&
    !element.matches(":disabled") &&
    element.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
  );
}
