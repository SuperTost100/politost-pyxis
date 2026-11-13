import { arrive, currentVisit, emptyTrail, forget, named, parseTrail, type Navigation, type PlaceName, type Trail } from "./trail";

/**
 * Keeps the trail (`trail.ts`) beside the window's history: the router reports every navigation it finishes, and the
 * trail lives in session storage, so a reload keeps it and a new window starts without one. A trail that cannot be
 * read or written means no history: every page then goes back to its parent.
 */

const STORE = "pyxis.trail";

function load(): Trail {
  try {
    return parseTrail(sessionStorage.getItem(STORE));
  } catch {
    return emptyTrail;
  }
}

let trail = load();
const listeners = new Set<() => void>();

function update(next: Trail) {
  if (next === trail) return;
  trail = next;
  try {
    sessionStorage.setItem(STORE, JSON.stringify(trail));
  } catch {
    // Without storage the trail still holds for this page's life; a reload then starts without one.
  }
  for (const listener of listeners) listener();
}

export function readTrail(): Trail {
  return trail;
}

export function watchTrail(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Writes the name a page gives itself on its history entry. */
export function nameVisit(key: string, name: PlaceName): void {
  update(named(trail, key, name));
}

/** After a delete: the entries that showed it are no longer a place to go back to. */
export function forgetPlaces(gone: (path: string) => boolean): void {
  update(forget(trail, gone));
}

/**
 * What had the focus, as a key that finds it again once the page is drawn anew: its `data-focus-key`, its id, a link's
 * address, or a button's name.
 */
export function focusKeyOf(element: Element | null): string | undefined {
  if (!(element instanceof HTMLElement) || element === document.body) return undefined;
  const marked = element.closest<HTMLElement>("[data-focus-key]");
  if (marked) return `key:${marked.dataset.focusKey}`;
  if (element.id) return `id:${element.id}`;
  const href = element.getAttribute("href");
  if (element instanceof HTMLAnchorElement && href) return `href:${href}`;
  const name = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
  if ((element instanceof HTMLButtonElement || element.getAttribute("role") === "button") && name) return `name:${name}`;
  return undefined;
}

function findByFocusKey(key: string): HTMLElement[] {
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (kind === "key") return [...document.querySelectorAll<HTMLElement>(`[data-focus-key="${CSS.escape(value)}"]`)];
  if (kind === "id") return [...document.querySelectorAll<HTMLElement>(`[id="${CSS.escape(value)}"]`)];
  if (kind === "href") return [...document.querySelectorAll<HTMLElement>(`a[href="${CSS.escape(value)}"]`)];
  if (kind === "name")
    return [...document.querySelectorAll<HTMLElement>("button, [role=button]")].filter(
      (element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim() === value,
    );
  return [];
}

let stopWaiting: (() => void) | null = null;

/**
 * After going back: the focus returns to what opened the page left behind (the path's step, the map's tile, the row),
 * once that page has drawn it, or else to the page's main heading. The page does not scroll unless that element is out
 * of sight. A click or a key of the student's own meanwhile ends the wait.
 *
 * The page being left is still on screen for a moment, and it may have a button of the same name, so what is there now
 * counts only once the wait is over, except the sidebar, which stays.
 */
function returnFocus(opener: string | undefined) {
  stopWaiting?.();
  const stale = new Set(document.querySelectorAll("a, button, h1, [id], [role=button], [data-focus-key]"));
  const usable = (element: HTMLElement, late: boolean) =>
    element.isConnected &&
    !element.closest("[inert]") &&
    !element.matches(":disabled") &&
    (late || !stale.has(element) || element.closest(".px-side") !== null);
  const place = (element: HTMLElement) => {
    finish();
    if (element.tabIndex < 0 && !element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  };
  const look = (late: boolean) => {
    const found = opener ? findByFocusKey(opener).find((element) => usable(element, late)) : undefined;
    if (found) return place(found);
    if (!opener || late) {
      const heading = [...document.querySelectorAll<HTMLElement>("main h1, h1")].find((element) => usable(element, late));
      if (heading) return place(heading);
    }
    if (late) finish();
  };
  const observer = new MutationObserver(() => look(false));
  const timer = window.setTimeout(() => look(true), 2000);
  const cancel = () => finish();
  function finish() {
    observer.disconnect();
    window.clearTimeout(timer);
    document.removeEventListener("pointerdown", cancel, true);
    document.removeEventListener("keydown", cancel, true);
    if (stopWaiting === finish) stopWaiting = null;
  }
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("pointerdown", cancel, true);
  document.addEventListener("keydown", cancel, true);
  stopWaiting = finish;
}

type RouterState = {
  historyAction: Navigation["action"];
  location: { key: string; pathname: string; search: string; state: unknown };
};

function viaOf(state: unknown): Navigation["via"] {
  const via = (state as { via?: unknown } | null)?.via;
  return via === "sidebar" || via === "outside" ? via : undefined;
}

/** Records every navigation the router finishes, from the page the window opens on. */
export function trackHistory(router: { state: RouterState; subscribe: (fn: (state: RouterState) => void) => unknown }): void {
  let seen: string | null = null;
  const see = (state: RouterState, first: boolean) => {
    const { location } = state;
    if (location.key === seen) return;
    seen = location.key;
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    const action = state.historyAction;
    update(
      arrive(trail, {
        action,
        key: location.key,
        idx: typeof idx === "number" ? idx : 0,
        path: location.pathname + location.search,
        via: viaOf(location.state),
        opener: action === "PUSH" ? focusKeyOf(document.activeElement) : undefined,
      }),
    );
    if (action === "POP" && !first) returnFocus(currentVisit(trail)?.opener);
    else if (action !== "POP") stopWaiting?.();
  };
  see(router.state, true);
  router.subscribe((state) => see(state, false));
}
