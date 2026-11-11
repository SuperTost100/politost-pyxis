import { afterEach, describe, expect, it, vi } from "vitest";
import { doorTarget, isExamPagePath, isMapPath, rememberDoorPath } from "./doors";

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

describe("doorTarget", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("goes back to where a door was left, but never from Exams into the Library", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    rememberDoorPath("/exams/cards");
    expect(doorTarget("exams", "/flashcards")).toBe("/exams/cards");
    rememberDoorPath("/exams/library");
    expect(doorTarget("exams", "/flashcards")).toBe("/exams");
    expect(doorTarget("exams", "/exams/library")).toBe("/exams");
    rememberDoorPath("/maps/s1");
    expect(doorTarget("maps", "/flashcards")).toBe("/maps/s1");
  });
});
