/**
 * How a sidebar row and a Vai section open a section's page: the page starts a new trail (`history.ts`), so it has
 * nothing behind it to go back to and lights its own row. When the window already shows that address, the page takes
 * its own place, which is the router's rule for a link and keeps a second press from adding to the history.
 */
export function sectionNavigation(
  to: string,
  here: { pathname: string; search: string },
): { state: { via: "sidebar" }; replace: boolean } {
  return { state: { via: "sidebar" }, replace: here.pathname + here.search === to };
}
