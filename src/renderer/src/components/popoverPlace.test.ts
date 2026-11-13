import { describe, expect, it } from "vitest";
import { EDGE, GAP, MIN_ROOM, placePopover } from "./popoverPlace";

const button = (top: number, left = 500, width = 120, height = 32) => ({
  top,
  bottom: top + height,
  left,
  right: left + width,
});
const panel = (height: number) => ({ width: 400, height });

/** The panel's top and bottom edges in the window, as the browser draws them from the style the placement gives. */
function edges(place: ReturnType<typeof placePopover>, height: number, viewHeight: number) {
  const drawn = Math.min(height, place.maxHeight);
  if (place.top !== undefined) return { top: place.top, bottom: place.top + drawn };
  const bottom = viewHeight - place.bottom!;
  return { top: bottom - drawn, bottom };
}

describe("placing a popover", () => {
  it("hangs under its button, 8px away, when the whole panel fits there", () => {
    const place = placePopover(button(40), panel(300), { width: 1280, height: 800 });
    expect(place.top).toBe(40 + 32 + GAP);
    expect(place.bottom).toBeUndefined();
    expect(place.maxHeight).toBe(800 - EDGE - (40 + 32 + GAP));
  });

  it("opens above a button near the bottom when there is more room there", () => {
    // Under the button: 600 - 8 - 548 = 44px. Above it: 500 - 8 - 8 = 484px.
    const place = placePopover(button(500), panel(300), { width: 1280, height: 600 });
    expect(place.top).toBeUndefined();
    expect(place.bottom).toBe(600 - (500 - GAP));
    expect(edges(place, 300, 600)).toEqual({ top: 192, bottom: 492 });
  });

  it("shrinks to the room and scrolls when neither side holds the whole panel", () => {
    // The finding's window: a button ending at 200px in a window 300px high, and a panel taller than the window.
    const place = placePopover(button(168), panel(500), { width: 1280, height: 300 });
    const { top, bottom } = edges(place, 500, 300);
    expect(top).toBeGreaterThanOrEqual(EDGE);
    expect(bottom).toBeLessThanOrEqual(300 - EDGE);
    expect(place.maxHeight).toBeGreaterThanOrEqual(MIN_ROOM);
  });

  it("fills the window, over its button, when no side has room for a usable panel", () => {
    const place = placePopover(button(60), panel(500), { width: 1280, height: 150 });
    expect(place).toMatchObject({ top: EDGE, maxHeight: 150 - 2 * EDGE });
  });

  it("stays inside the window at every height, whichever edge the button is near", () => {
    for (const viewHeight of [150, 300, 420, 600, 800, 1200]) {
      for (const top of [0, 8, 40, 120, 250, 400, 580, 760, 1100]) {
        // A button that is inside the window.
        if (top + 32 > viewHeight) continue;
        for (const height of [80, 300, 520, 2000]) {
          const place = placePopover(button(top), panel(height), { width: 1280, height: viewHeight });
          const { top: start, bottom } = edges(place, height, viewHeight);
          const note = `window ${viewHeight}, button at ${top}, panel ${height}`;
          expect(start, note).toBeGreaterThanOrEqual(0);
          expect(bottom, note).toBeLessThanOrEqual(viewHeight);
        }
      }
    }
  });

  it("lines up with the button's right edge and stays inside the window sideways", () => {
    expect(placePopover(button(40, 700), panel(200), { width: 1280, height: 800 }).left).toBe(820 - 400);
    expect(placePopover(button(40, 10, 60), panel(200), { width: 1280, height: 800 }).left).toBe(EDGE);
    expect(placePopover(button(40, 1250, 60), panel(200), { width: 1280, height: 800 }).left).toBe(1280 - EDGE - 400);
  });
});
