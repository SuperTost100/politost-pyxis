import { describe, expect, it } from "vitest";
import { isExamPagePath, isMapPath } from "./paths";

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

describe("isExamPagePath", () => {
  it("is an exam's own page, not the new-exam wizard or a page below the exam", () => {
    expect(isExamPagePath("/plans/p1")).toBe(true);
    expect(isExamPagePath("/plans/p1/")).toBe(true);
    expect(isExamPagePath("/plans/new")).toBe(false);
    expect(isExamPagePath("/plans/new/")).toBe(false);
    expect(isExamPagePath("/plans/new/guided")).toBe(false);
    expect(isExamPagePath("/plans/p1/settings")).toBe(false);
    expect(isExamPagePath("/plans/p1/lesson/t1")).toBe(false);
    expect(isExamPagePath("/exams")).toBe(false);
  });
});
