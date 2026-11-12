import { describe, expect, it } from "vitest";
import { captureRect } from "./capture-rect";

const window = { width: 1280, height: 800 };

describe("captureRect", () => {
  it("keeps the page's rectangle at the default zoom", () => {
    expect(captureRect({ x: 200, y: 100, width: 600, height: 400 }, 1, window)).toEqual({
      x: 200,
      y: 100,
      width: 600,
      height: 400,
    });
  });

  it("grows a rectangle on half pixels to whole pixels", () => {
    expect(captureRect({ x: 10.5, y: 20.25, width: 100.25, height: 50.5 }, 1, window)).toEqual({
      x: 10,
      y: 20,
      width: 101,
      height: 51,
    });
  });

  it.each([
    [0.8, { x: 160, y: 80, width: 480, height: 240 }],
    [1.5, { x: 300, y: 150, width: 900, height: 450 }],
    [2, { x: 400, y: 200, width: 1200, height: 600 }],
  ])("covers zoom times as many window pixels at zoom %s", (zoom, expected) => {
    expect(captureRect({ x: 200, y: 100, width: 600, height: 300 }, zoom, { width: 2560, height: 1600 })).toEqual(expected);
  });

  it("does not gain a pixel from a product that lands a hair above a whole number", () => {
    // In floating point 100 * 1.1 is 110.00000000000001, which a plain ceil would round up to 111.
    expect(100 * 1.1).toBeGreaterThan(110);
    expect(captureRect({ x: 0, y: 0, width: 100, height: 100 }, 1.1, window)).toEqual({
      x: 0,
      y: 0,
      width: 110,
      height: 110,
    });
  });

  it("gives only the visible part of a canvas scrolled partly out of the window", () => {
    expect(captureRect({ x: -50, y: 500, width: 400, height: 600 }, 1.5, window)).toEqual({
      x: 0,
      y: 750,
      width: 525,
      height: 50,
    });
  });

  it("gives nothing when no part of the rectangle is in the window", () => {
    expect(captureRect({ x: 2000, y: 0, width: 100, height: 100 }, 1, window)).toBeNull();
    expect(captureRect({ x: -300, y: 0, width: 100, height: 100 }, 1, window)).toBeNull();
  });
});
