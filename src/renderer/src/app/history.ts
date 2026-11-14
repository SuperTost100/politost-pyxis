import { arrive, currentVisit, emptyTrail, forget, named, pageOf, parseTrail, TRAIL_STORE, type Navigation, type PlaceName, type Trail } from "./trail";

/**
 * Keeps the trail (`trail.ts`) beside the window's history: the router reports every navigation it finishes, and the
 * trail lives in session storage, so a reload keeps it and a new window starts without one. A trail that cannot be
 * read or written means no history: every page then goes back to its parent.
 */

function load(): Trail {
  try {
    return parseTrail(sessionStorage.getItem(TRAIL_STORE));
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
    sessionStorage.setItem(TRAIL_STORE, JSON.stringify(trail));
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

/**
 * A word for the page a way back is about to open, which that page reads once on arrival (`takeArrivalNote`): what a
 * navigation's `state` would carry, except that going back through the window's history cannot carry one. It is for the
 * next page the router finishes opening and no later one, so a destination that never reads it leaves nothing behind.
 */
let note: { value: unknown; arrived: boolean } | null = null;

export function noteForArrival(value: unknown): void {
  note = { value, arrived: false };
}

/** The note the page now showing was left, once; undefined when there is none or the page is not the one it was for. */
export function takeArrivalNote<T>(): T | undefined {
  if (!note?.arrived) return undefined;
  const { value } = note;
  note = null;
  return value as T;
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

function findByFocusKey(key: string, nearest: boolean): HTMLElement[] {
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  // A key names its place from the outside in ("path:topic:part:2"), so a step that is folded away falls back to the
  // nearest of its rows still on screen.
  if (kind === "key")
    for (let key = value; key; key = nearest && key.includes(":") ? key.slice(0, key.lastIndexOf(":")) : "") {
      const found = [...document.querySelectorAll<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`)];
      if (found.length) return found;
    }
  if (kind === "id") return [...document.querySelectorAll<HTMLElement>(`[id="${CSS.escape(value)}"]`)];
  if (kind === "href") return [...document.querySelectorAll<HTMLElement>(`a[href="${CSS.escape(value)}"]`)];
  if (kind === "name")
    return [...document.querySelectorAll<HTMLElement>("button, [role=button]")].filter(
      (element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim() === value,
    );
  return [];
}

let stopWaiting: (() => void) | null = null;
/** A back control is about to replace its page with the page's parent, which is also going back. */
let backToParent: string | null = null;

/** Called by a back control right before it opens the page's parent in place of the page. */
export function goingBackToParent(to: string): void {
  // Kept by page, so a move the leave guard stops does not make a later rewrite of an address count as going back.
  backToParent = pageOf(to);
}

/**
 * After going back: the focus returns to what opened the page left behind (the path's step, the map's tile, the row),
 * once that page has drawn it, or else to the page's main heading. The page does not scroll unless that element is out
 * of sight. A click or a key of the student's own meanwhile ends the wait.
 *
 * The page being left is still on screen for a moment, and it may have a button of the same name, so what is there now
 * counts only once the wait is over, except the sidebar, which stays. A page still reading its data may draw the
 * element late, so a folded step falls back to its row only after a moment. A page that moves the focus itself wins.
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
  const started = performance.now();
  const look = (late: boolean) => {
    // A page that places the focus itself on arrival, as a quiz does on its question, keeps it there.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !stale.has(active)) return finish();
    const nearest = late || performance.now() - started > 500;
    const found = opener ? findByFocusKey(opener, nearest).find((element) => usable(element, late)) : undefined;
    if (found) return place(found);
    if (!opener || late) {
      const heading = [...document.querySelectorAll<HTMLElement>("main h1, h1")].find((element) => usable(element, late));
      if (heading) return place(heading);
    }
    if (late) finish();
  };
  const observer = new MutationObserver(() => look(false));
  const settle = window.setTimeout(() => look(false), 600);
  const timer = window.setTimeout(() => look(true), 2000);
  const cancel = () => finish();
  function finish() {
    observer.disconnect();
    window.clearTimeout(settle);
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

export function viaOf(state: unknown): Navigation["via"] {
  const via = (state as { via?: unknown } | null)?.via;
  return via === "sidebar" || via === "outside" ? via : undefined;
}

/** Records every navigation the router finishes, from the page the window opens on. */
export function trackHistory(router: { state: RouterState; subscribe: (fn: (state: RouterState) => void) => unknown }): void {
  let seen: string | null = null;
  // A button that turns busy while it opens a page loses the focus before the page opens, so the last element that had
  // the focus stands in for it.
  // Its key is read as it takes the focus, before a busy button changes its words.
  let lastFocus: Element | null = null;
  const keyAtFocus = new WeakMap<Element, string | undefined>();
  document.addEventListener("focusin", (event) => {
    lastFocus = event.target instanceof Element ? event.target : null;
    if (lastFocus) keyAtFocus.set(lastFocus, focusKeyOf(lastFocus));
  });
  const openerKey = () => {
    const active = document.activeElement;
    const element = active && active !== document.body ? active : lastFocus;
    return element ? (keyAtFocus.has(element) ? keyAtFocus.get(element) : focusKeyOf(element)) : undefined;
  };
  const see = (state: RouterState, first: boolean) => {
    const { location } = state;
    // The router reports every change of its state; a navigation is a new entry or another address.
    const at = `${location.key} ${location.pathname}${location.search}`;
    if (at === seen) return;
    seen = at;
    // The navigation that finishes after a note was left is the one the note is for; the next one ends it.
    if (note) note = note.arrived ? null : { ...note, arrived: true };
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    const action = state.historyAction;
    update(
      arrive(trail, {
        action,
        key: location.key,
        idx: typeof idx === "number" ? idx : 0,
        path: location.pathname + location.search,
        via: viaOf(location.state),
        opener: action === "PUSH" ? openerKey() : undefined,
      }),
    );
    if ((action === "POP" && !first) || (action === "REPLACE" && backToParent === pageOf(location.pathname))) returnFocus(currentVisit(trail)?.opener);
    else if (action !== "POP") stopWaiting?.();
    backToParent = null;
  };
  see(router.state, true);
  router.subscribe((state) => see(state, false));
}
