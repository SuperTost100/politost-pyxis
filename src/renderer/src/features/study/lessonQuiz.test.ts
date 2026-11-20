import { describe, expect, it } from "vitest";
import { startedQuizSize, type Started } from "./lessonQuiz";

const row = (extra: Partial<Started>): Started => ({ kind: "quiz", topicId: "t1", state: "open", total: 10, ...extra });

describe("startedQuizSize", () => {
  it("is the size of the topic's quiz that was started and written", () => {
    expect(startedQuizSize([row({})], "t1")).toBe(10);
    expect(startedQuizSize([row({ state: "ready", total: 8 })], "t1")).toBe(8);
  });

  it("is null when the topic has none, or the size is not known yet", () => {
    expect(startedQuizSize(undefined, "t1")).toBeNull();
    expect(startedQuizSize([], "t1")).toBeNull();
    expect(startedQuizSize([row({ topicId: "t2" })], "t1")).toBeNull();
    expect(startedQuizSize([row({ kind: "review" })], "t1")).toBeNull();
    expect(startedQuizSize([row({ state: "writing", total: 3 })], "t1")).toBeNull();
    expect(startedQuizSize([row({ state: "stopped" })], "t1")).toBeNull();
    expect(startedQuizSize([row({ state: "expired" })], "t1")).toBeNull();
    expect(startedQuizSize([row({ total: 0 })], "t1")).toBeNull();
  });
});
