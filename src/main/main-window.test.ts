import { describe, expect, it } from "vitest";
import { endsWithMainWindow, firstWindowHold, needsMainWindow, windowAction } from "./main-window";

describe("the main window", () => {
  it("ends the app when it closes on Windows and Linux, and not on macOS", () => {
    expect(endsWithMainWindow("win32")).toBe(true);
    expect(endsWithMainWindow("linux")).toBe(true);
    expect(endsWithMainWindow("darwin")).toBe(false);
  });

  it("is made again when there is none, or the one there was is destroyed, once startup has made the first", () => {
    expect(needsMainWindow(null, true)).toBe(true);
    expect(needsMainWindow({ isDestroyed: () => true }, true)).toBe(true);
    expect(needsMainWindow({ isDestroyed: () => false }, true)).toBe(false);
  });

  it("is left to startup before it has made the first, which may still be copying the old profile's settings", () => {
    expect(needsMainWindow(null, false)).toBe(false);
    expect(needsMainWindow({ isDestroyed: () => true }, false)).toBe(false);
  });
});

describe("what a request that needs the main window does", () => {
  const live = { isDestroyed: () => false };
  const gone = { isDestroyed: () => true };

  it("uses the window there is, makes one when startup is done and there is none, and waits for startup otherwise", () => {
    expect(windowAction(live, true)).toBe("use");
    expect(windowAction(live, false)).toBe("use");
    expect(windowAction(null, true)).toBe("create");
    expect(windowAction(gone, true)).toBe("create");
    // Startup makes the first window itself, and keeps what was asked until then (a reminder's page, a plan file).
    expect(windowAction(null, false)).toBe("wait");
    expect(windowAction(gone, false)).toBe("wait");
  });

  it("agrees with `needsMainWindow`", () => {
    for (const main of [null, live, gone])
      for (const done of [true, false]) expect(needsMainWindow(main, done)).toBe(windowAction(main, done) === "create");
  });
});

describe("the test seam that holds the first window", () => {
  it("is read only in a run that sets PYXIS_E2E=1", () => {
    expect(firstWindowHold({ PYXIS_E2E_FIRST_WINDOW_HOLD: "/tmp/hold" })).toBeUndefined();
    expect(firstWindowHold({ PYXIS_E2E: "0", PYXIS_E2E_FIRST_WINDOW_HOLD: "/tmp/hold" })).toBeUndefined();
    expect(firstWindowHold({ PYXIS_E2E: "1" })).toBeUndefined();
    expect(firstWindowHold({ PYXIS_E2E: "1", PYXIS_E2E_FIRST_WINDOW_HOLD: "/tmp/hold" })).toBe("/tmp/hold");
  });
});
