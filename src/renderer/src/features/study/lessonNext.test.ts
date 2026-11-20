import { describe, expect, it } from "vitest";
import { lessonNext } from "./lessonNext";

const intro = { activity: "intro", topicId: null };
const diagnostic = { activity: "diagnostic", topicId: null };

describe("lessonNext", () => {
  it("keeps the plan's suggestion when it is a step of a topic, or the plan's next lesson", () => {
    const quiz = { activity: "quiz", topicId: "t2" };
    expect(lessonNext({ next: quiz, topicId: "t1", mastery: 0.2, done: [] })).toBe(quiz);
    const lesson = { activity: "lesson", topicId: "t2" };
    expect(lessonNext({ next: lesson, topicId: "t1", mastery: 0.2, done: [] })).toBe(lesson);
    expect(lessonNext({ next: null, topicId: "t1", mastery: 0.2, done: [] })).toBeNull();
  });

  it("does not offer the introduction or the diagnostic after a lesson: they come before it", () => {
    // A topic below the middle goes on to its exercises, one at or above it to its quiz.
    expect(lessonNext({ next: intro, topicId: "t1", mastery: 0, done: [] })).toEqual({ activity: "practice", topicId: "t1" });
    expect(lessonNext({ next: diagnostic, topicId: "t1", mastery: 0.49, done: [] })).toEqual({ activity: "practice", topicId: "t1" });
    expect(lessonNext({ next: intro, topicId: "t1", mastery: 0.5, done: [] })).toEqual({ activity: "quiz", topicId: "t1" });
  });

  it("skips a step of this topic that was done, and says nothing when none is left", () => {
    const practice = { activity: "practice", topicId: "t1" };
    const quiz = { activity: "quiz", topicId: "t1" };
    expect(lessonNext({ next: intro, topicId: "t1", mastery: 0, done: [practice] })).toEqual(quiz);
    // Another topic's steps do not count.
    expect(lessonNext({ next: intro, topicId: "t1", mastery: 0, done: [{ activity: "practice", topicId: "t2" }] })).toEqual(practice);
    expect(lessonNext({ next: intro, topicId: "t1", mastery: 0, done: [practice, quiz] })).toBeNull();
    // Without a mastery the topic starts at its exercises.
    expect(lessonNext({ next: intro, topicId: "t1", mastery: null, done: [] })).toEqual(practice);
  });
});
