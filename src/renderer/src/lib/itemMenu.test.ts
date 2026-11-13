import { describe, expect, it, vi } from "vitest";
import { isMenuKey, keepsSystemMenu, menuTrigger, movedBy, pointBelow } from "./itemMenu";

const plain = { closest: () => null };
const field = { closest: (selector: string) => (selector.includes("textarea") ? {} : null) };

function click(target: unknown, over: Record<string, unknown> = {}) {
  return { clientX: 120, clientY: 48, target, defaultPrevented: false, preventDefault: vi.fn(), ...over } as never;
}
function press(target: unknown, key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    target,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...over,
  } as never;
}
/** A pointer pressed on `item`: by default the secondary button of a mouse. */
function pressOn(item: unknown, over: Record<string, unknown> = {}) {
  return { currentTarget: item, button: 2, pointerType: "mouse", ...over } as never;
}
const focused = { ...plain, getBoundingClientRect: () => ({ left: 30, bottom: 90, right: 400 }) };

describe("item menu behaviour", () => {
  it("opens the menu at the pointer on a right-click and keeps the browser's own menu away", () => {
    const open = vi.fn();
    const item = {};
    const event = click(plain, { currentTarget: item });
    const trigger = menuTrigger(open);
    trigger.onPointerDown(pressOn(item));
    trigger.onContextMenu(event);
    // The item the handler is on comes along, so the menu can close when that item moves.
    expect(open).toHaveBeenCalledWith({ x: 120, y: 48 }, false, item);
    expect((event as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
  });

  it("leaves text fields and marked places to the system's menu", () => {
    const open = vi.fn();
    const event = click(field);
    menuTrigger(open).onContextMenu(event);
    expect(open).not.toHaveBeenCalled();
    expect((event as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled();
    expect(keepsSystemMenu(field)).toBe(true);
    expect(keepsSystemMenu(plain)).toBe(false);
    expect(keepsSystemMenu(null)).toBe(false);
  });

  it("opens under the focused element for the context-menu key and Shift+F10, and for nothing else", () => {
    const open = vi.fn();
    const trigger = menuTrigger(open);
    const item = {};
    const key = press(focused, "ContextMenu", { currentTarget: item });
    trigger.onKeyDown(key);
    expect(open).toHaveBeenLastCalledWith({ x: 38, y: 90 }, true, item);
    expect((key as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
    trigger.onKeyDown(press(focused, "F10", { shiftKey: true }));
    expect(open).toHaveBeenCalledTimes(2);
    for (const other of [press(focused, "F10"), press(focused, "Enter"), press(focused, "F10", { shiftKey: true, ctrlKey: true })])
      trigger.onKeyDown(other);
    expect(open).toHaveBeenCalledTimes(2);
    // A key press inside a text field keeps the field's own menu.
    trigger.onKeyDown(press(field, "ContextMenu"));
    expect(open).toHaveBeenCalledTimes(2);
  });

  /**
   * One item with a menu as `ItemMenu.tsx` keeps it: whether it is open, held with the events, and the requests that
   * reached `open`. `dropdownCloses` stands for the dropdown, which closes an open menu on a `contextmenu` outside it
   * before the item hears that event.
   */
  function item() {
    const state = { shown: false, opened: [] as Array<{ at: { x: number; y: number }; byKey: boolean }> };
    const element = {};
    const handlers = () =>
      menuTrigger(
        (at, byKey) => {
          state.shown = true;
          state.opened.push({ at, byKey });
        },
        true,
        () => state.shown,
      );
    return {
      state,
      element,
      key: (type: "down" | "up") => {
        const event = press(focused, "ContextMenu", { currentTarget: element });
        // Each event reaches the item through handlers made by the render that came last.
        if (type === "down") handlers().onKeyDown(event);
        else handlers().onKeyUp(event);
        return (event as { preventDefault: () => void }).preventDefault;
      },
      keyboardContextMenu: ({ dropdownCloses = false } = {}) => {
        if (dropdownCloses) state.shown = false;
        const event = click(focused, { currentTarget: element, clientX: 215, clientY: 75 });
        handlers().onContextMenu(event);
        return (event as { preventDefault: () => void }).preventDefault;
      },
      rightClick: (button = 2) => {
        if (state.shown) state.shown = false;
        const trigger = handlers();
        trigger.onPointerDown(pressOn(element, { button }));
        trigger.onContextMenu(click(plain, { currentTarget: element }));
      },
    };
  }
  const underIt = { at: { x: 38, y: 90 }, byKey: true };
  const atPointer = { at: { x: 120, y: 48 }, byKey: false };

  it("opens a key's menu once under the focused element, whichever order the key press and its contextmenu come in", () => {
    // The key press, then a contextmenu for the same key (Windows sends it on the release, to the focused element).
    const first = item();
    first.key("down");
    expect(first.key("up")).toHaveBeenCalled();
    expect(first.keyboardContextMenu()).toHaveBeenCalled();
    expect(first.state.opened).toEqual([underIt]);
    // The same, when the dropdown closed the menu for that contextmenu before the item heard it: the menu opens again
    // in the same place, still as the keyboard's.
    const closed = item();
    closed.key("down");
    closed.keyboardContextMenu({ dropdownCloses: true });
    expect(closed.state.opened).toEqual([underIt, underIt]);
    expect(closed.state.shown).toBe(true);
    // The contextmenu first, then the key press.
    const second = item();
    second.keyboardContextMenu();
    second.key("down");
    second.key("up");
    expect(second.state.opened).toEqual([underIt]);
    // Only the contextmenu, on a platform where the page never sees the key.
    const third = item();
    third.keyboardContextMenu();
    expect(third.state.opened).toEqual([underIt]);
    // In every order, a right-click after it opens the menu at the pointer, as the pointer's.
    for (const menu of [first, closed, second, third]) {
      menu.rightClick();
      expect(menu.state.opened.at(-1)).toEqual(atPointer);
    }
  });

  it("takes a contextmenu after a plain click for the keyboard's, and one after Ctrl+click or a touch for the pointer's", () => {
    const open = vi.fn();
    const element = {};
    const trigger = menuTrigger(open);
    trigger.onPointerDown(pressOn(element, { button: 0 }));
    trigger.onContextMenu(click(focused, { currentTarget: element }));
    expect(open).toHaveBeenLastCalledWith({ x: 38, y: 90 }, true, element);
    for (const pressed of [
      { button: 0, pointerType: "mouse", ctrlKey: true },
      { button: 0, pointerType: "touch" },
      { button: 2, pointerType: "mouse" },
    ]) {
      trigger.onPointerDown(pressOn(element, pressed));
      trigger.onContextMenu(click(focused, { currentTarget: element }));
      expect(open, JSON.stringify(pressed)).toHaveBeenLastCalledWith({ x: 120, y: 48 }, false, element);
    }
  });

  it("does not take a right-click on another item for one on this item", () => {
    const open = vi.fn();
    const trigger = menuTrigger(open);
    trigger.onPointerDown(pressOn({}));
    const other = {};
    trigger.onContextMenu(click(focused, { currentTarget: other }));
    expect(open).toHaveBeenLastCalledWith({ x: 38, y: 90 }, true, other);
  });

  it("leaves the release of other keys, and of the menu key in a text field, alone", () => {
    const trigger = menuTrigger(vi.fn());
    const enter = press(focused, "Enter");
    trigger.onKeyUp(enter);
    const inField = press(field, "ContextMenu");
    trigger.onKeyUp(inField);
    expect((enter as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled();
    expect((inField as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled();
  });

  it("does nothing for an item whose menu is disabled", () => {
    const open = vi.fn();
    const trigger = menuTrigger(open, false);
    const event = click(plain);
    trigger.onContextMenu(event);
    trigger.onKeyDown(press(focused, "ContextMenu"));
    const release = press(focused, "ContextMenu");
    trigger.onKeyUp(release);
    expect(open).not.toHaveBeenCalled();
    expect((release as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled();
    expect((event as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled();
  });

  it("recognises the menu keys", () => {
    const base = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    expect(isMenuKey({ ...base, key: "ContextMenu" })).toBe(true);
    expect(isMenuKey({ ...base, key: "F10", shiftKey: true })).toBe(true);
    expect(isMenuKey({ ...base, key: "F10" })).toBe(false);
    expect(pointBelow({ left: 10, bottom: 20, right: 14 })).toEqual({ x: 14, y: 20 });
  });
});

describe("whether a scroll moved an item", () => {
  const box = (left: number, top: number, width = 34, height = 34) => ({ left, top, right: left + width, bottom: top + height });

  it("counts an item that the page scrolled, however far, in either direction", () => {
    expect(movedBy(box(1221, 12), box(1221, 62))).toBe(true);
    expect(movedBy(box(1221, 12), box(1221, 5))).toBe(true);
    expect(movedBy(box(100, 40), box(60, 40))).toBe(true);
  });

  it("leaves an item that did not move, or moved by a pixel", () => {
    expect(movedBy(box(1221, 12), box(1221, 12))).toBe(false);
    expect(movedBy(box(1221, 12), box(1221.5, 12.9))).toBe(false);
  });

  it("leaves a button that was pressed when the menu opened and is released now", () => {
    // Pressed: scale(0.94) about its centre, so each edge sits 1.02px in from where it is at rest.
    const pressed = box(1221.02, 12.02, 31.96, 31.96);
    expect(movedBy(pressed, box(1220, 11))).toBe(false);
    expect(movedBy(box(1220, 11), pressed)).toBe(false);
  });

  it("counts a pressed button that was also scrolled", () => {
    expect(movedBy(box(1221.02, 12.02, 31.96, 31.96), box(1220, 41))).toBe(true);
  });

  it("leaves an item that grew or shrank in place, which the page did not scroll", () => {
    expect(movedBy(box(40, 100, 300, 60), box(40, 100, 300, 120))).toBe(false);
    expect(movedBy(box(40, 100, 300, 60), box(40, 100, 500, 60))).toBe(false);
  });
});
