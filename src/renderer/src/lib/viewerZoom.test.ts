import { describe, expect, it } from "vitest";
import { ZOOM_START, zoomFrom } from "./viewerZoom";

describe("zoomFrom", () => {
  it("steps through the sizes from the start", () => {
    expect(zoomFrom(ZOOM_START, 1)).toBe(150);
    expect(zoomFrom(150, 1)).toBe(200);
    expect(zoomFrom(ZOOM_START, -1)).toBe(75);
    expect(zoomFrom(75, -1)).toBe(50);
  });

  it("stays at the ends", () => {
    expect(zoomFrom(300, 1)).toBe(300);
    expect(zoomFrom(50, -1)).toBe(50);
  });
});
