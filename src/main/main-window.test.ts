import { describe, expect, it } from "vitest";
import { endsWithMainWindow, needsMainWindow } from "./main-window";

describe("the main window", () => {
  it("ends the app when it closes on Windows and Linux, and not on macOS", () => {
    expect(endsWithMainWindow("win32")).toBe(true);
    expect(endsWithMainWindow("linux")).toBe(true);
    expect(endsWithMainWindow("darwin")).toBe(false);
  });

  it("is made again when there is none, or the one there was is destroyed", () => {
    expect(needsMainWindow(null)).toBe(true);
    expect(needsMainWindow({ isDestroyed: () => true })).toBe(true);
    expect(needsMainWindow({ isDestroyed: () => false })).toBe(false);
  });
});
