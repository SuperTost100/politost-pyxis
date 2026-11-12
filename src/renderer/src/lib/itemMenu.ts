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
type MenuPointerEvent = { currentTarget?: EventTarget | null; button?: number; pointerType?: string; ctrlKey?: boolean };

/** The box of the element an event is on, for a menu that hangs below it. */
function boxOf(target: unknown): { left: number; bottom: number; right: number } | null {
  const element = target as { getBoundingClientRect?: () => { left: number; bottom: number; right: number } } | null;
  return element?.getBoundingClientRect ? element.getBoundingClientRect() : null;
}

/**
 * The item a pointer was last pressed on in a way that can ask for a context menu (any press but a plain primary click
 * of a mouse: the secondary button, Ctrl+click on a Mac, a long press of a finger or a pen), until a `contextmenu`
 * arrives. A right-click always presses the pointer on the item before its `contextmenu`, on every platform. A
 * `contextmenu` that comes with no such press was asked for by a key (the context-menu key, Shift+F10, or the system on
 * its own) and is sent to the focused element, so it opens the menu as the keyboard does. Kept outside the handlers
 * because each render makes new ones, and there is one pointer.
 */
let pressedOn: EventTarget | null = null;

/**
 * The handlers an item takes so its menu answers a right-click and the menu keys. `open` receives the point, whether
 * a key asked (to give focus back to where it was) and the item the handler is on. Pass `enabled: false` for an item
 * whose menu is disabled, which leaves its events alone.
 *
 * One key press can ask for the menu twice: by the key press, and by a `contextmenu` that the system sends for the key
 * before or after it (or instead of it, where the page never sees the key). `isOpen` says whether the item's menu is
 * open at that moment; while it is, a key's request leaves the menu and the focus as they are, so the menu opens once.
 * It is read when the event arrives, so it must be kept with the events, not with a render that may not have happened.
 */
export function menuTrigger(
  open: (at: MenuPoint, byKey: boolean, item: EventTarget | null) => void,
  enabled = true,
  isOpen: () => boolean = () => false,
) {
  const openByKey = (box: { left: number; bottom: number; right: number }, item: EventTarget | null) => {
    if (!isOpen()) open(pointBelow(box), true, item);
  };
  return {
    onPointerDown(event: MenuPointerEvent) {
      const plainClick = event.button === 0 && event.pointerType === "mouse" && !event.ctrlKey;
      pressedOn = plainClick ? null : (event.currentTarget ?? null);
    },
    onContextMenu(event: MenuMouseEvent) {
      if (!enabled || event.defaultPrevented || keepsSystemMenu(event.target as Targetable)) return;
      event.preventDefault();
      const item = event.currentTarget ?? null;
      const byPointer = pressedOn !== null && pressedOn === item;
      pressedOn = null;
      const box = byPointer ? null : boxOf(event.target);
      if (box) openByKey(box, item);
      else open({ x: event.clientX, y: event.clientY }, false, item);
    },
    onKeyDown(event: MenuKeyEvent) {
      if (!enabled || event.defaultPrevented || !isMenuKey(event) || keepsSystemMenu(event.target as Targetable)) return;
      const box = boxOf(event.target);
      if (!box) return;
      event.preventDefault();
      pressedOn = null;
      openByKey(box, event.currentTarget ?? null);
    },
    // Chromium on Windows sends the context-menu key's `contextmenu` when the key is released, to the element that has
    // focus then, unless the release is handled. Handling it keeps that second request from being sent at all.
    onKeyUp(event: MenuKeyEvent) {
      if (!enabled || event.defaultPrevented || !isMenuKey(event) || keepsSystemMenu(event.target as Targetable)) return;
      event.preventDefault();
    },
  };
}
