import { expect, it } from "vitest";
import { MAX_PAGE_PIXELS, MAX_PAGE_SIDE, pageScale } from "./pdf-ocr";

const drawn = (width: number, height: number) => {
  const scale = pageScale(width, height);
  return { width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
};

it("draws a normal page at 1.5 and shrinks a huge or very thin one within both caps, after rounding", () => {
  // A4 in points.
  expect(pageScale(595, 842)).toBe(1.5);
  for (const [width, height] of [
    [14_400, 14_400],
    [1_000_000_000, 1],
    [1, 1_000_000_000],
    [100_000, 3],
  ] as const) {
    const size = drawn(width, height);
    expect(size.width).toBeLessThanOrEqual(MAX_PAGE_SIDE);
    expect(size.height).toBeLessThanOrEqual(MAX_PAGE_SIDE);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
    expect(size.width).toBeGreaterThan(0);
  }
  // A page with no size keeps the normal scale rather than dividing by zero.
  expect(pageScale(0, 842)).toBe(1.5);
});
