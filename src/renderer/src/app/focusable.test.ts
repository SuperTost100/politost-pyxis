import { describe, expect, it } from "vitest";
import { canTakeFocus, type FocusCandidate } from "./focusable";

const element = (patch: Partial<{ connected: boolean; inert: boolean; disabled: boolean; shown: boolean }> = {}): FocusCandidate => {
  const { connected = true, inert = false, disabled = false, shown = true } = patch;
  return {
    isConnected: connected,
    closest: (selector: string) => (selector === "[inert]" && inert ? {} : null),
    matches: (selector: string) => selector === ":disabled" && disabled,
    checkVisibility: () => shown,
  };
};

describe("canTakeFocus", () => {
  it("accepts an element that is on the page, enabled and shown", () => {
    expect(canTakeFocus(element())).toBe(true);
  });

  it("refuses one that is gone, inert or disabled", () => {
    expect(canTakeFocus(element({ connected: false }))).toBe(false);
    expect(canTakeFocus(element({ inert: true }))).toBe(false);
    expect(canTakeFocus(element({ disabled: true }))).toBe(false);
  });

  it("refuses one that is hidden, such as a button in a folded row, which cannot take the focus", () => {
    expect(canTakeFocus(element({ shown: false }))).toBe(false);
  });

  it("asks for visibility the way a focus does: display, content-visibility and the visibility property", () => {
    let asked: unknown;
    canTakeFocus({ ...element(), checkVisibility: (options) => ((asked = options), true) });
    expect(asked).toEqual({ visibilityProperty: true, contentVisibilityAuto: true });
  });
});
