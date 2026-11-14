import { describe, expect, it } from "vitest";
import { focusInOpenSurface } from "./pageKeys";

// A stand-in for an element: it is inside a surface when the selector names that surface.
const inside = (surface: string) => ({ closest: (selector: string) => (selector.includes(surface) ? {} : null) });

describe("keys of a study page while a surface has the focus", () => {
  it("belong to the open surface: a dialog, a menu, the Attività list, a dropdown", () => {
    for (const surface of ["[role=dialog]", ".px-item-menu", ".px-jobs", ".ant-select-dropdown", ".ant-drawer"])
      expect(focusInOpenSurface(inside(surface)), surface).toBe(true);
  });

  it("stay with the page when the focus is anywhere else", () => {
    expect(focusInOpenSurface(inside(".px-cards"))).toBe(false);
    expect(focusInOpenSurface(null)).toBe(false);
  });
});
