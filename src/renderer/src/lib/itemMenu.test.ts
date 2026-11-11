import { describe, expect, it, vi } from "vitest";
import { isMenuKey, keepsSystemMenu, menuTrigger, pointBelow } from "./itemMenu";

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
const focused = { ...plain, getBoundingClientRect: () => ({ left: 30, bottom: 90, right: 400 }) };

describe("item menu behaviour", () => {
  it("opens the menu at the pointer on a right-click and keeps the browser's own menu away", () => {
    const open = vi.fn();
    const item = {};
    const event = click(plain, { currentTarget: item });
    menuTrigger(open).onContextMenu(event);
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

  it("does nothing for an item whose menu is disabled", () => {
    const open = vi.fn();
    const trigger = menuTrigger(open, false);
    const event = click(plain);
    trigger.onContextMenu(event);
    trigger.onKeyDown(press(focused, "ContextMenu"));
    expect(open).not.toHaveBeenCalled();
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
