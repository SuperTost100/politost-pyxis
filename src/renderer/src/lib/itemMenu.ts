/**
 * One behaviour for every row, tile or item that has a menu behind three dots: a right-click opens that same menu at the
 * pointer, and so do the context-menu key and Shift+F10 on the item that has focus, where the focused element is. The
 * rules live here, free of the page, so they are checked by a unit test; `ItemMenu.tsx` draws the menu and the places
 * that open a system menu call `menuTrigger` themselves.
 */

/** Where a menu opens, in the window's coordinates. */
export type MenuPoint = { x: number; y: number };

/** What the rules read of an element: only `closest`, so a test can stand in for a real one. */
type Targetable = { closest(selector: string): unknown } | null;

/**
 * Places where the system's own right-click menu does a job (copy, paste, spelling), so an item's menu leaves them
 * alone: text fields, and anything marked `data-native-menu`.
 */
const KEEPS_SYSTEM_MENU = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [data-native-menu]";

/** Whether a right-click or key press on `target` belongs to the system's menu. */
export function keepsSystemMenu(target: Targetable): boolean {
  return Boolean(target && typeof target.closest === "function" && target.closest(KEEPS_SYSTEM_MENU));
}

/** The keys that ask for a context menu: the context-menu key, and Shift+F10 where the keyboard has none. */
export function isMenuKey(key: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (key.key === "ContextMenu") return true;
  return key.key === "F10" && key.shiftKey && !key.ctrlKey && !key.altKey && !key.metaKey;
}

/** The point under the focused element's start, which a key-opened menu hangs from. */
export function pointBelow(box: { left: number; bottom: number; right: number }): MenuPoint {
  return { x: Math.min(box.left + 8, box.right), y: box.bottom };
}

type MenuMouseEvent = {
  clientX: number;
  clientY: number;
  currentTarget?: EventTarget | null;
  target: EventTarget | Targetable;
  defaultPrevented: boolean;
  preventDefault(): void;
};
type MenuKeyEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  currentTarget?: EventTarget | null;
  target: EventTarget | Targetable;
  defaultPrevented: boolean;
  preventDefault(): void;
};

/**
 * The handlers an item takes so its menu answers a right-click and the menu keys. `open` receives the point, whether
 * a key asked (to give focus back to where it was) and the item the handler is on. Pass `enabled: false` for an item whose menu is disabled, which
 * leaves its events alone.
 */
export function menuTrigger(open: (at: MenuPoint, byKey: boolean, item: EventTarget | null) => void, enabled = true) {
  return {
    onContextMenu(event: MenuMouseEvent) {
      if (!enabled || event.defaultPrevented || keepsSystemMenu(event.target as Targetable)) return;
      event.preventDefault();
      open({ x: event.clientX, y: event.clientY }, false, event.currentTarget ?? null);
    },
    onKeyDown(event: MenuKeyEvent) {
      if (!enabled || event.defaultPrevented || !isMenuKey(event) || keepsSystemMenu(event.target as Targetable)) return;
      const focused = event.target as { getBoundingClientRect?: () => { left: number; bottom: number; right: number } } | null;
      if (!focused?.getBoundingClientRect) return;
      // Handling the key press keeps Chromium from also sending a `contextmenu` event for it.
      event.preventDefault();
      open(pointBelow(focused.getBoundingClientRect()), true, event.currentTarget ?? null);
    },
  };
}
