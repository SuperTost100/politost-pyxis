import { describe, expect, it } from "vitest";
import { arrowTarget, letterIndex, letterKeysHere } from "./finalKeys";

/** An element that matches the selectors listed in `inside`, as `closest` would find an ancestor. */
const element = (tagName: string, ...inside: string[]) => ({
  tagName,
  closest: (selector: string) => (inside.some((name) => selector.split(", ").includes(name)) ? {} : null),
});

describe("letter keys on the final question", () => {
  it("maps A to D to the options, in either case, and nothing past the last option", () => {
    expect(letterIndex("a", 4)).toBe(0);
    expect(letterIndex("C", 4)).toBe(2);
    expect(letterIndex("d", 3)).toBeNull();
    expect(letterIndex("Enter", 4)).toBeNull();
    expect(letterIndex("1", 4)).toBeNull();
  });

  it("answers from the page, the question and the sheet's title, never from a control, field, menu or dialog", () => {
    expect(letterKeysHere(null, false)).toBe(true);
    expect(letterKeysHere(element("BODY"), false)).toBe(true);
    expect(letterKeysHere(element("BUTTON", "button"), true)).toBe(true);
    expect(letterKeysHere(element("H1", ".px-reader-column"), false)).toBe(true);
    expect(letterKeysHere(element("BUTTON", "button", ".px-reader-column"), false)).toBe(false);
    expect(letterKeysHere(element("TEXTAREA", "textarea"), false)).toBe(false);
    expect(letterKeysHere(element("LI", "[role=menuitem]"), false)).toBe(false);
    expect(letterKeysHere(element("DIV", "[role=dialog]", ".px-reader-column"), false)).toBe(false);
    expect(letterKeysHere(element("DIV", ".px-selection-menu"), false)).toBe(false);
    // A link in the parts column is outside the sheet.
    expect(letterKeysHere(element("A", "a[href]"), false)).toBe(false);
    expect(letterKeysHere(element("NAV"), false)).toBe(false);
  });

  it("moves between the options with the arrows, round at both ends", () => {
    expect(arrowTarget("ArrowDown", 0, 3)).toBe(1);
    expect(arrowTarget("ArrowDown", 2, 3)).toBe(0);
    expect(arrowTarget("ArrowUp", 0, 3)).toBe(2);
    expect(arrowTarget("ArrowLeft", 0, 3)).toBeNull();
  });
});
