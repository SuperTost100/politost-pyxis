import { describe, expect, it } from "vitest";
import { isMapPath } from "./doors";

describe("isMapPath", () => {
  it("tells a map's page from the exam pages around it", () => {
    expect(isMapPath("/plans/p1/map/t1")).toBe(true);
    expect(isMapPath("/plans/p1")).toBe(false);
    expect(isMapPath("/plans/p1/map")).toBe(false);
    expect(isMapPath("/plans/p1/lesson/t1")).toBe(false);
    expect(isMapPath("/maps")).toBe(false);
    expect(isMapPath("/maps/")).toBe(false);
    expect(isMapPath("/maps/s1")).toBe(true);
    expect(isMapPath("/maps/s1/t1")).toBe(true);
  });
});
