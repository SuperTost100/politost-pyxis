import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { placeOf, placePaths, studyExam } from "./places";

/** Every route pattern in router.tsx, read as text: the shell's children are relative to "/". */
function routePatterns(): string[] {
  const source = readFileSync(resolve(import.meta.dirname, "router.tsx"), "utf8");
  return [...source.matchAll(/\bpath: "([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((path) => path !== "/")
    .map((path) => (path.startsWith("/") || path === "*" ? path : `/${path}`));
}

describe("places", () => {
  it("has a row for every route, so a new page cannot leave out its name and its parent", () => {
    const routes = routePatterns();
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((route) => !placePaths.includes(route))).toEqual([]);
  });

  it("leads a page under an exam back to the exam, and the exam back to Esami", () => {
    expect(placeOf("/plans/p1/lesson/t1?part=2").parent?.to).toBe("/plans/p1");
    expect(placeOf("/plans/p1/redo?attempt=a").parent?.to).toBe("/plans/p1");
    expect(placeOf("/plans/p1/sources").parent?.to).toBe("/plans/p1");
    expect(placeOf("/plans/p1/settings").parent?.to).toBe("/plans/p1");
    expect(placeOf("/plans/p1")).toEqual({ name: { key: "places.exam" }, parent: { to: "/exams", name: { key: "doors.exams" } } });
    // The review's pages are study steps of the exam, so they lead to the exam and not to the review's start.
    expect(placeOf("/plans/p1/review/questions?attempt=a").parent).toEqual({ to: "/plans/p1", name: { key: "places.exam" } });
    expect(placeOf("/plans/p1/review/cards").parent?.to).toBe("/plans/p1");
  });

  it("names the exam a study page belongs to, and no other page", () => {
    const study = [
      "/plans/p1/lesson/t1?part=2",
      "/plans/p1/practice/t1",
      "/plans/p1/intro",
      "/plans/p1/diagnostic",
      "/plans/p1/quiz/t1?attempt=a",
      "/plans/p1/gap/g1",
      "/plans/p1/redo?attempt=a",
      "/plans/p1/past",
      "/plans/p1/cards/t1",
      "/plans/p1/review",
      "/plans/p1/review/cards",
      "/plans/p1/review/questions?attempt=a",
      "/cards/due?exam=p1&topic=none",
    ];
    for (const path of study) expect(studyExam(path), path).toBe("p1");
    // The exam itself, its other pages, a simulation and every page of another section are not steps.
    for (const path of [
      "/plans/p1",
      "/plans/p1/settings",
      "/plans/p1/sources",
      "/plans/p1/simulation",
      "/plans/p1/exam/a",
      "/plans/p1/map/t1",
      "/exams/mistakes?exam=p1",
      "/cards/due",
      "/cards/due?exam=none",
      "/ask/c1",
      "/maps",
    ])
      expect(studyExam(path), path).toBeNull();
  });

  it("follows `?exam=` to the exam a page was narrowed to", () => {
    expect(placeOf("/exams/mistakes").parent?.to).toBe("/exams");
    expect(placeOf("/exams/mistakes?exam=p1").parent?.to).toBe("/plans/p1");
    expect(placeOf("/flashcards/all?exam=p1").parent?.to).toBe("/plans/p1");
    expect(placeOf("/exams/cards?exam=p1").parent?.to).toBe("/plans/p1");
    expect(placeOf("/flashcards/all").parent).toEqual({ to: "/flashcards", name: { key: "flashcards.title" } });
    expect(placeOf("/cards/due").parent?.to).toBe("/flashcards");
    expect(placeOf("/cards/due?exam=p1&topic=none").parent?.to).toBe("/plans/p1");
    expect(placeOf("/cards/due?subject=s&exam=none").parent?.to).toBe("/flashcards");
  });

  it("leads a map to Mappe at its subject, and gives the sections no parent", () => {
    expect(placeOf("/maps/s%201/t1").parent?.to).toBe("/maps?subject=s%201");
    expect(placeOf("/plans/p1/map/t1").parent?.to).toBe("/maps");
    for (const section of ["/ask", "/ask/c1", "/exams", "/maps", "/flashcards", "/exams/library"])
      expect(placeOf(section).parent, section).toBeNull();
  });

  it("tells the new-exam wizard from an exam, and Settings' sections from the old subjects address", () => {
    expect(placeOf("/plans/new").name).toEqual({ key: "wizard.title" });
    expect(placeOf("/settings/engines")).toEqual({ name: { key: "settings.title" }, parent: { to: "/ask", name: { key: "doors.ask" } } });
    expect(placeOf("/onboarding?again=1").parent?.to).toBe("/settings/profile");
    expect(placeOf("/exams/get")).toEqual({ name: { key: "shared.title" }, parent: { to: "/exams", name: { key: "doors.exams" } } });
    expect(placeOf("/onboarding").parent).toBeNull();
    expect(placeOf("/nowhere/at/all")).toEqual({ name: null, parent: null });
  });
});
