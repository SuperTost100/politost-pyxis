import { describe, expect, it } from "vitest";
import { endsWithMainWindow, needsMainWindow } from "./main-window";

describe("the main window", () => {
  it("ends the app when it closes on Windows and Linux, and not on macOS", () => {
    expect(endsWithMainWindow("win32")).toBe(true);
    expect(endsWithMainWindow("linux")).toBe(true);
    expect(endsWithMainWindow("darwin")).toBe(false);
  });

  it("is made again when there is none, or the one there was is destroyed, once startup has made the first", () => {
    expect(needsMainWindow(null, true)).toBe(true);
    expect(needsMainWindow({ isDestroyed: () => true }, true)).toBe(true);
  });

  it("is never made a second time", () => {
    expect(needsMainWindow({ isDestroyed: () => false }, true)).toBe(false);
    expect(needsMainWindow({ isDestroyed: () => false }, false)).toBe(false);
  });

  it("is left to startup before it has made the first, which may still be showing a dialog or copying settings", () => {
    expect(needsMainWindow(null, false)).toBe(false);
    expect(needsMainWindow({ isDestroyed: () => true }, false)).toBe(false);
  });
});
