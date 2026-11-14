import type { BackTarget } from "./usePlace";

/**
 * The back control of the page on screen, which Vai > Indietro, the mouse's back button and the swipe run: the same
 * `go()` as the control on the page. A page registers while it is mounted (`usePlace`); with none registered, the page
 * has no way back and Indietro has nothing to do.
 */
const pages: Array<() => BackTarget | null> = [];
const listeners = new Set<() => void>();

export function registerBack(page: () => BackTarget | null): () => void {
  pages.push(page);
  changed();
  return () => {
    pages.splice(pages.indexOf(page), 1);
    changed();
  };
}

/** The registered page's way back as it is now, the page opened last first. */
export function registeredBack(): BackTarget | null {
  for (let at = pages.length - 1; at >= 0; at -= 1) {
    const target = pages[at]!();
    if (target) return target;
  }
  return null;
}

/** A page's way back may have appeared or gone; whoever shows it asks again. */
export function changed(): void {
  for (const listener of listeners) listener();
}

export function watchBack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
