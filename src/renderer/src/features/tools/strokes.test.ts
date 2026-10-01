import { describe, expect, it } from "vitest";
import { strokeHits } from "./strokes";

describe("strokeHits", () => {
  it("hits the middle of a segment, not only the endpoints", () => {
    const stroke = {
      width: 4,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    };
    expect(strokeHits(stroke, { x: 50, y: 0 })).toBe(true);
    expect(strokeHits(stroke, { x: 50, y: 40 })).toBe(false);
  });
});
