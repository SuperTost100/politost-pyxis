import { describe, expect, it } from "vitest";
import { isStillHere } from "./useStillHere";

const idle = (pathname: string, key: string) => ({
  navigation: { state: "idle" as const },
  location: { pathname, key },
});

describe("isStillHere", () => {
  const page = { pathname: "/maps/an/t-limits", key: "a1", mounted: true };

  it("holds for the entry the page was drawn for, while the router is idle on it", () => {
    expect(isStillHere(idle("/maps/an/t-limits", "a1"), page)).toBe(true);
  });

  it("holds when there is no router to ask", () => {
    expect(isStillHere(undefined, page)).toBe(true);
  });

  it("fails when another entry has the same path: a request for job A must not clean the entry of job B", () => {
    expect(isStillHere(idle("/maps/an/t-limits", "b2"), page)).toBe(false);
  });

  it("fails on another path, and while a navigation is under way", () => {
    expect(isStillHere(idle("/plans/p-fis", "a1"), page)).toBe(false);
    expect(
      isStillHere({ ...idle("/maps/an/t-limits", "a1"), navigation: { state: "loading" } }, page),
    ).toBe(false);
  });

  it("fails once the page has unmounted, even if the router still shows its entry", () => {
    expect(isStillHere(idle("/maps/an/t-limits", "a1"), { ...page, mounted: false })).toBe(false);
    expect(isStillHere(undefined, { ...page, mounted: false })).toBe(false);
  });
});
