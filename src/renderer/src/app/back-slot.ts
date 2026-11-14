/** Where a page's back control leads (`usePlace`), and what it says. */
export type BackTarget = {
  /** The place's name, in the app's language: the control's text. */
  name: string;
  /** "Torna a {{place}}", what a screen reader hears. */
  label: string;
  /** The path it leads to. */
  to: string;
  go: () => void;
  /** True while `beforeLeave` runs. */
  busy: boolean;
  /** The page saves what it holds in `beforeLeave`, so leaving by this way loses nothing the student typed. */
  saves: boolean;
};

/**
 * The back control of the page on screen, which Vai > Indietro, the mouse's back button and the swipe run: the same
 * `go()` as the control on the page. A page registers while it is mounted (`usePlace`), under the key of the history
 * entry it shows; with none registered, the page has no way back and Indietro has nothing to do.
 */
type Page = { key: string; target: () => BackTarget | null };
const pages: Page[] = [];
const listeners = new Set<() => void>();

export function registerBack(key: string, target: () => BackTarget | null): () => void {
  const page = { key, target };
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
    const target = pages[at]!.target();
    if (target) return target;
  }
  return null;
}

/**
 * The way back of the page that shows the history entry `key`: null when it has none, undefined while that page has not
 * registered yet. The router moves to a new entry before the new page is drawn, and the page registers after it is
 * drawn, so for a moment the page registered is still the one before.
 */
export function backOf(key: string): BackTarget | null | undefined {
  for (let at = pages.length - 1; at >= 0; at -= 1) if (pages[at]!.key === key) return pages[at]!.target();
  return undefined;
}

/**
 * Runs `run` with the way back of the page at entry `key`: at once when that page has registered, else as soon as it
 * does, so Indietro pressed while a page is arriving goes back from that page instead of being lost. A page that never
 * registers (it has no way back, or the student moved on) leaves it after `limit` milliseconds.
 */
export function whenArrived(key: string, run: (target: BackTarget | null) => void, limit = 5000): void {
  const now = backOf(key);
  if (now !== undefined) return run(now);
  const check = () => {
    const target = backOf(key);
    if (target === undefined) return;
    stop();
    run(target);
  };
  const stop = () => {
    listeners.delete(check);
    clearTimeout(timer);
  };
  const timer = setTimeout(stop, limit);
  listeners.add(check);
}

/** A page's way back may have appeared or gone; whoever shows it asks again. */
export function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function watchBack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
