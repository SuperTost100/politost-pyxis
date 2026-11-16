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

/** The edges of an element's box, as `getBoundingClientRect` gives them. */
type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Whether the page's scroll moved an item from where `before` drew it to `now`. An edge that moved by more than a pixel
 * counts only when the centre moved with it: a button shrinks about its centre while it is pressed (`Button.css`),
 * which moves its edges by up to a pixel and its centre not at all, and the menu of a right-click opens while the button
 * is still pressed, before it is released. And a centre that moved counts only when an edge did: an item that grew or
 * shrank with its top left corner in place moves its centre, and the page did not scroll.
 */
export function movedBy(before: Box, now: Box): boolean {
  const along = (edge: number, centre: number) => Math.abs(edge) > 1 && Math.abs(centre) > 1;
  return (
    along(now.left - before.left, (now.left + now.right - before.left - before.right) / 2) ||
    along(now.top - before.top, (now.top + now.bottom - before.top - before.bottom) / 2)
  );
}

/** Where a scroller was scrolled to, and how far it can be: the numbers an element has under these names. */
export type Scrolled = {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
};

/**
 * Whether a scroll was the page's own and not the student's: the scroller had been scrolled to `before` (its `scrollTop`
 * and `scrollLeft` at the last scroll it sent), the content under it then got shorter or narrower, and the browser, with
 * no room left for that position, moved it back to the end. A scroll the student makes can come to rest at the end too,
 * but only by moving away from where it was, towards the end, so a scroll that moves back from `before` onto the end
 * (within a pixel) can only be the page giving way. Read from the scroller's own numbers at the scroll event, so it
 * needs nothing watched between events.
 */
export function clampedBy(before: { top: number; left: number }, now: Scrolled): boolean {
  const clamped = (was: number, at: number, extent: number, view: number) => at < was && at >= extent - view - 1;
  return (
    clamped(before.top, now.scrollTop, now.scrollHeight, now.clientHeight) ||
    clamped(before.left, now.scrollLeft, now.scrollWidth, now.clientWidth)
  );
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
type MenuPointerEvent = { target?: EventTarget | null; button?: number; pointerType?: string; ctrlKey?: boolean };

/** The box of the element an event is on, for a menu that hangs below it. */
function boxOf(target: unknown): { left: number; bottom: number; right: number } | null {
  const element = target as { getBoundingClientRect?: () => { left: number; bottom: number; right: number } } | null;
  return element?.getBoundingClientRect ? element.getBoundingClientRect() : null;
}

/**
 * The element a pointer was last pressed on in a way that can ask for a context menu (any press but a plain primary
 * click of a mouse: the secondary button, Ctrl+click on a Mac, a long press of a finger or a pen), until a `contextmenu`
 * arrives. A right-click always presses the pointer on the item before its `contextmenu`, on every platform. A
 * `contextmenu` that comes with no such press was asked for by a key (the context-menu key, Shift+F10, or the system on
 * its own) and is sent to the focused element, so it opens the menu as the keyboard does. It is the element pressed, not
 * the item whose handler heard the press, so an item inside another (the dots in a page's head, each with the menu)
 * finds its own press there after the item around it has heard the same one. Kept outside the handlers because each
 * render makes new ones, and there is one pointer.
 */
let pressedOn: EventTarget | null = null;

/** Whether `item` is the element pressed or holds it. */
function holds(item: EventTarget | null, pressed: EventTarget | null): boolean {
  return item !== null && pressed !== null && (item === pressed || Boolean((item as { contains?(node: unknown): boolean }).contains?.(pressed)));
}

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
      pressedOn = plainClick ? null : (event.target ?? null);
    },
    onContextMenu(event: MenuMouseEvent) {
      if (!enabled || event.defaultPrevented || keepsSystemMenu(event.target as Targetable)) return;
      event.preventDefault();
      const item = event.currentTarget ?? null;
      const byPointer = holds(item, pressedOn);
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
