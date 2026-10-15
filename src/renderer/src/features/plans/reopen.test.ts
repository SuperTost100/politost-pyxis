import { describe, expect, it } from "vitest";
import { reopenPath } from "./reopen";

const step = (activity: string, extra: Record<string, string | null> = {}) => ({
  activity,
  topicId: "t1",
  ...extra,
});

describe("reopening a finished step", () => {
  it("opens the lesson that was read, by its item", () => {
    expect(reopenPath("p", step("lesson", { itemId: "i 1" }))).toBe("/plans/p/lesson/t1?item=i%201");
    // A step recorded without its item opens the topic's lesson as before.
    expect(reopenPath("p", step("lesson"))).toBe("/plans/p/lesson/t1");
    expect(reopenPath("p", step("lesson", { itemId: null }))).toBe("/plans/p/lesson/t1");
  });

  it("opens cards and exercises in review mode", () => {
    expect(reopenPath("p", step("cards"))).toBe("/plans/p/cards/t1?review=1");
    expect(reopenPath("p", step("practice"))).toBe("/plans/p/practice/t1?review=1");
  });

  it("opens an attempt read-only, and falls back without one", () => {
    expect(reopenPath("p", step("quiz", { attemptId: "a1" }))).toBe("/plans/p/quiz/t1?attempt=a1");
    expect(reopenPath("p", step("gaps", { attemptId: "a1" }))).toBe("/plans/p/quiz/t1?attempt=a1");
    expect(reopenPath("p", step("quiz"))).toBe("/plans/p/lesson/t1");
    expect(reopenPath("p", { activity: "diagnostic", topicId: null, attemptId: "a1" })).toBe(
      "/plans/p/diagnostic?attempt=a1",
    );
    expect(reopenPath("p", { activity: "simulation", topicId: null, attemptId: "a1" })).toBe("/plans/p/exam/a1");
    expect(reopenPath("p", { activity: "simulation", topicId: null })).toBe("/plans/p/simulation");
  });

  it("has nowhere to go for a topic step without a topic", () => {
    expect(reopenPath("p", { activity: "lesson", topicId: null })).toBeNull();
    expect(reopenPath("p", { activity: "intro", topicId: null })).toBe("/plans/p/intro");
  });
});
