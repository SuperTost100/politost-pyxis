import { describe, expect, it } from "vitest";
import { isMenuCommand, isNavState } from "./menu";

describe("isNavState", () => {
  it("takes exactly two booleans", () => {
    expect(isNavState({ back: true, forward: false })).toBe(true);
    expect(isNavState({ back: false, forward: false })).toBe(true);
  });

  it("refuses anything else", () => {
    for (const value of [
      null,
      undefined,
      "back",
      [],
      {},
      { back: true },
      { back: true, forward: "yes" },
      { back: 1, forward: 0 },
      { back: true, forward: false, extra: true },
    ])
      expect(isNavState(value), JSON.stringify(value)).toBe(false);
  });
});

describe("isMenuCommand", () => {
  it("knows Avanti", () => {
    expect(isMenuCommand("forward")).toBe(true);
    expect(isMenuCommand("sideways")).toBe(false);
  });
});
