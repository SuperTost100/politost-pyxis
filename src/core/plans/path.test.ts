import { describe, expect, it } from "vitest";
import { reachableTarget } from "../../shared/plan-file";
import {
  bestRecommendation,
  recommend,
  suggestStep,
  topicSuggestion,
  type Step,
  type TopicStatus,
} from "./path";

const topic = (id: string, mastery = 0, extra: Partial<TopicStatus> = {}): TopicStatus => ({
  id,
  mastery,
  dueCards: 0,
  severeGaps: 0,
  daysIdle: 0,
  graded: 0,
  ...extra,
});
const step = (activity: Step["activity"], topicId: string | null = null) => ({ activity, topicId });
const base = { hasIntro: true, target: 0.8, daysToExam: 30 };

describe("suggestStep", () => {
  it("suggests the introduction, then the diagnostic, on a new plan", () => {
    const topics = [topic("a"), topic("b")];
    expect(suggestStep({ ...base, topics, steps: [] })).toMatchObject({
      activity: "intro",
      reason: "intro",
    });
    expect(suggestStep({ ...base, topics, steps: [step("intro")] })).toMatchObject({
      activity: "diagnostic",
      reason: "diagnostic",
    });
    // Without an introduction the diagnostic comes first.
    expect(suggestStep({ ...base, hasIntro: false, topics, steps: [] })?.activity).toBe(
      "diagnostic",
    );
  });

  it("stops suggesting the intro and the diagnostic once the student studies", () => {
    const topics = [topic("a"), topic("b")];
    // Skipping both and reading the first lesson moves on: the topic just read is practised next.
    expect(suggestStep({ ...base, topics, steps: [step("lesson", "a")] })).toMatchObject({
      activity: "practice",
      topicId: "a",
      reason: "consolidate",
    });
    // Evidence from earlier quizzes counts as study too.
    expect(suggestStep({ ...base, topics: [topic("a", 0.3), topic("b")], steps: [] })).toMatchObject(
      { activity: "lesson", topicId: "a", reason: "next" },
    );
  });

  it("suggests a smart text on the next unread topic in the plan's order", () => {
    // Both topics read here have had their three graded activities, so the path moves on.
    const topics = [topic("a", 0.4, { graded: 3 }), topic("b"), topic("c", 0, { graded: 3 })];
    const steps = [
      step("intro"),
      step("diagnostic"),
      step("lesson", "a"),
      step("practice", "a"),
      step("quiz", "a"),
    ];
    expect(suggestStep({ ...base, topics, steps })).toMatchObject({
      activity: "lesson",
      topicId: "b",
      reason: "next",
    });
    // A lesson read out of order is skipped: c was read, so b is still next.
    expect(
      suggestStep({ ...base, topics, steps: [...steps, step("lesson", "c"), step("quiz", "c")] }),
    ).toMatchObject({ activity: "lesson", topicId: "b" });
  });

  it("picks a guided exercise or a quiz for a read topic by its mastery", () => {
    const steps = [step("lesson", "a")];
    expect(suggestStep({ ...base, topics: [topic("a", 0.2)], steps })?.activity).toBe("practice");
    expect(suggestStep({ ...base, topics: [topic("a", 0.6)], steps })?.activity).toBe("quiz");
    // Every topic read and its stay over: the weakest one gets the exercise.
    const all = [topic("a", 0.7), topic("b", 0.3, { graded: 3 })];
    expect(
      suggestStep({
        ...base,
        topics: all,
        steps: [step("lesson", "a"), step("lesson", "b"), step("quiz", "b")],
      }),
    ).toMatchObject({ activity: "practice", topicId: "b", reason: "weakest" });
  });

  it("follows exercises with a quiz on the same topic, so practice never repeats forever", () => {
    // Practice is not graded and leaves mastery where it was: without the quiz the weakest topic gets practice again.
    const all = [topic("a", 0.7), topic("b", 0.3)];
    const read = [step("lesson", "a"), step("lesson", "b")];
    expect(
      suggestStep({ ...base, topics: all, steps: [...read, step("practice", "b")] }),
    ).toMatchObject({ activity: "quiz", topicId: "b", reason: "check" });
    // Practice on a topic just read is checked the same way, before the next lesson.
    expect(
      suggestStep({
        ...base,
        topics: [topic("a", 0.2), topic("b")],
        steps: [step("lesson", "a"), step("practice", "a")],
      }),
    ).toMatchObject({ activity: "quiz", topicId: "a", reason: "check" });
    // Once the quiz is taken and b's stay is over, the weakest topic is back to exercises.
    const over = [topic("a", 0.7), topic("b", 0.3, { graded: 3 })];
    expect(
      suggestStep({ ...base, topics: over, steps: [...read, step("practice", "b"), step("quiz", "b")] }),
    ).toMatchObject({ activity: "practice", topicId: "b", reason: "weakest" });
    // With every topic read and nowhere else to go, practice on the weakest topic is still checked by a quiz.
    expect(
      suggestStep({ ...base, topics: over, steps: [...read, step("quiz", "b"), step("practice", "b")] }),
    ).toMatchObject({ activity: "quiz", topicId: "b", reason: "check" });
    // A topic already at the target needs no check.
    expect(
      suggestStep({
        ...base,
        topics: [topic("a", 0.9), topic("b", 0.3, { graded: 3 })],
        steps: [...read, step("practice", "a")],
      }),
    ).toMatchObject({ activity: "practice", topicId: "b", reason: "weakest" });
  });

  it("stays on the topic just read, alternating exercises and quizzes, until it holds or has three activities", () => {
    const topics = (graded: number, mastery = 0.3) => [topic("a", mastery, { graded }), topic("b")];
    const lesson = [step("lesson", "a")];
    // Right after the lesson: exercises.
    expect(suggestStep({ ...base, topics: topics(0), steps: lesson })).toMatchObject({
      activity: "practice",
      topicId: "a",
      reason: "consolidate",
    });
    // Exercises are followed by a quiz, whether they were rated (one activity) or not (none).
    for (const graded of [0, 1])
      expect(
        suggestStep({ ...base, topics: topics(graded), steps: [...lesson, step("practice", "a")] }),
      ).toMatchObject({ activity: "quiz", topicId: "a", reason: "check" });
    // A quiz is followed by exercises again while the topic stays below 0.6.
    const twice = [...lesson, step("practice", "a"), step("quiz", "a")];
    expect(suggestStep({ ...base, topics: topics(2), steps: twice })).toMatchObject({
      activity: "practice",
      topicId: "a",
      reason: "stay",
    });
    // Unrated exercises do not count, so the quiz after them still keeps the path here.
    expect(
      suggestStep({ ...base, topics: topics(2), steps: [...twice, step("practice", "a")] }),
    ).toMatchObject({ activity: "quiz", topicId: "a", reason: "check" });
    // Starting with a quiz instead of exercises still alternates.
    expect(
      suggestStep({ ...base, topics: topics(1), steps: [...lesson, step("quiz", "a")] }),
    ).toMatchObject({ activity: "practice", topicId: "a", reason: "stay" });
    // At 0.6 the topic holds and the next chapter comes, even after one activity.
    expect(
      suggestStep({ ...base, topics: topics(1, 0.6), steps: [...lesson, step("quiz", "a")] }),
    ).toMatchObject({ activity: "lesson", topicId: "b", reason: "next" });
    // A target under 0.6 ends the stay at the target.
    expect(
      suggestStep({
        ...base,
        target: 0.5,
        topics: topics(1, 0.55),
        steps: [...lesson, step("quiz", "a")],
      }),
    ).toMatchObject({ activity: "lesson", topicId: "b" });
  });

  it("moves on after three graded activities however they went", () => {
    const steps = [step("lesson", "a"), step("practice", "a"), step("quiz", "a"), step("practice", "a")];
    // Three misses leave mastery low; the path still moves to the next chapter rather than checking the exercises.
    expect(
      suggestStep({ ...base, topics: [topic("a", 0.1, { graded: 3 }), topic("b")], steps }),
    ).toMatchObject({ activity: "lesson", topicId: "b", reason: "next" });
    expect(
      suggestStep({ ...base, topics: [topic("a", 0.1, { graded: 2 }), topic("b")], steps }),
    ).toMatchObject({ activity: "quiz", topicId: "a", reason: "check" });
  });

  it("stays on the latest lesson's topic, not on work done elsewhere since", () => {
    const topics = [topic("a", 0.2), topic("b", 0.2), topic("c", 0.4, { graded: 1 })];
    // A lesson read out of the path's order takes the stay; a quiz on another topic does not.
    expect(
      suggestStep({
        ...base,
        topics,
        steps: [step("lesson", "a"), step("lesson", "b"), step("quiz", "c")],
      }),
    ).toMatchObject({ activity: "practice", topicId: "b", reason: "consolidate" });
  });

  it("brings back a read topic left alone for seven days before a new chapter", () => {
    const steps = [step("lesson", "a"), step("lesson", "b")];
    const topics = (daysIdle: number, mastery = 0.5) => [
      topic("a", 0.5, { graded: 3, daysIdle: 2 }),
      topic("b", mastery, { graded: 3, daysIdle }),
      topic("c"),
    ];
    expect(suggestStep({ ...base, topics: topics(8), steps })).toMatchObject({
      activity: "quiz",
      topicId: "b",
      reason: "review",
      count: 8,
    });
    // Six days is not yet idle, and a topic at the target needs no review.
    expect(suggestStep({ ...base, topics: topics(6), steps })).toMatchObject({
      activity: "lesson",
      topicId: "c",
    });
    expect(suggestStep({ ...base, topics: topics(9, 0.85), steps })).toMatchObject({
      activity: "lesson",
      topicId: "c",
    });
    // A topic never read is not reviewed, however long ago the diagnostic touched it.
    expect(
      suggestStep({
        ...base,
        topics: [topic("a", 0.5, { graded: 3 }), topic("b", 0.2, { daysIdle: 20 })],
        steps: [step("lesson", "a")],
      }),
    ).toMatchObject({ activity: "lesson", topicId: "b", reason: "next" });
    // The longest idle topic goes first.
    expect(
      suggestStep({
        ...base,
        topics: [
          topic("a", 0.3, { graded: 3, daysIdle: 10 }),
          topic("b", 0.2, { graded: 3, daysIdle: 12 }),
          topic("c"),
        ],
        steps,
      }),
    ).toMatchObject({ topicId: "b", reason: "review", count: 12 });
  });

  it("keeps due cards and severe gaps ahead of the stay and of a review, and the stay ahead of a review", () => {
    const steps = [step("lesson", "a"), step("lesson", "b")];
    const idle = topic("a", 0.4, { graded: 3, daysIdle: 9 });
    expect(
      suggestStep({ ...base, topics: [idle, topic("b", 0.2), topic("c", 0, { dueCards: 2 })], steps }),
    ).toMatchObject({ activity: "cards", topicId: "c", reason: "due" });
    expect(
      suggestStep({ ...base, topics: [idle, topic("b", 0.2, { severeGaps: 1 }), topic("c")], steps }),
    ).toMatchObject({ activity: "gaps", topicId: "b", reason: "gaps" });
    // b was read last and has not had its three activities yet, so it keeps the path before a's review.
    expect(suggestStep({ ...base, topics: [idle, topic("b", 0.2), topic("c")], steps })).toMatchObject({
      activity: "practice",
      topicId: "b",
      reason: "consolidate",
    });
    expect(
      suggestStep({ ...base, topics: [idle, topic("b", 0.2, { graded: 3 }), topic("c")], steps }),
    ).toMatchObject({ activity: "quiz", topicId: "a", reason: "review" });
  });

  it("puts due cards and severe gaps first", () => {
    const steps = [step("lesson", "a")];
    expect(
      suggestStep({ ...base, topics: [topic("a", 0.4), topic("b", 0, { dueCards: 4 })], steps }),
    ).toMatchObject({ activity: "cards", topicId: "b", reason: "due", count: 4 });
    expect(
      suggestStep({ ...base, topics: [topic("a", 0.4, { severeGaps: 2 }), topic("b")], steps }),
    ).toMatchObject({ activity: "gaps", topicId: "a", reason: "gaps", count: 2 });
  });

  it("suggests the simulation only when mastery is reasonable or the exam is close", () => {
    const steps = [step("lesson", "a"), step("lesson", "b")];
    expect(
      suggestStep({ ...base, topics: [topic("a", 0.85), topic("b", 0.9)], steps }),
    ).toMatchObject({ activity: "simulation", topicId: null, reason: "ready" });
    expect(
      suggestStep({ ...base, topics: [topic("a", 0.85), topic("b", 0.4)], steps })?.activity,
    ).not.toBe("simulation");
    expect(
      suggestStep({ ...base, daysToExam: 2, topics: [topic("a", 0.3), topic("b", 0.2)], steps }),
    ).toMatchObject({ activity: "simulation", reason: "examSoon" });
    // A plan with no study yet starts from the beginning even right before the exam.
    expect(
      suggestStep({ ...base, daysToExam: 1, topics: [topic("a"), topic("b")], steps: [] })?.activity,
    ).toBe("intro");
  });

  it("lets a 100% target suggest the simulation after a miss", () => {
    const topics = [topic("a", 0.99), topic("b", 0.99)];
    const steps = [step("lesson", "a"), step("lesson", "b")];
    expect(suggestStep({ ...base, target: 1, topics, steps })?.activity).not.toBe("simulation");
    expect(suggestStep({ ...base, target: reachableTarget(1), topics, steps })?.activity).toBe(
      "simulation",
    );
  });

  it("has nothing to suggest on a plan without topics once the intro is read", () => {
    expect(suggestStep({ ...base, topics: [], steps: [step("intro")] })).toBeNull();
  });
});

describe("topicSuggestion", () => {
  it("fits each topic: cards, gaps, lesson, then exercises", () => {
    expect(topicSuggestion(topic("a", 0, { dueCards: 1 }), true)).toBe("cards");
    expect(topicSuggestion(topic("a", 0, { severeGaps: 1 }), true)).toBe("gaps");
    expect(topicSuggestion(topic("a"), false)).toBe("lesson");
    expect(topicSuggestion(topic("a", 0.3), true)).toBe("practice");
    expect(topicSuggestion(topic("a", 0.7), true)).toBe("quiz");
  });
});

describe("recommend", () => {
  it("ranks due cards above an idle topic", () => {
    const dueInput = {
      dueCards: 3,
      severeGaps: 1,
      topicMastery: 0.4,
      target: 0.8,
      daysToExam: 10,
      daysIdle: 0,
      styleMatch: 0,
    };
    const idleInput = {
      dueCards: 0,
      severeGaps: 0,
      topicMastery: 0.7,
      target: 0.8,
      daysToExam: 10,
      daysIdle: 2,
      styleMatch: 0,
    };
    const due = recommend(dueInput);
    const idle = recommend(idleInput);
    expect(due.score).toBeGreaterThan(idle.score);
    expect(due.reason).toBe("3 cards due");
    expect(bestRecommendation([{ id: "idle", ...idleInput }, { id: "due", ...dueInput }])?.id).toBe(
      "due",
    );
    expect(due.score).toBeCloseTo(3 * 3 + 4 * 1 + 2 * 0.4 * (1 + 2 / 10));
  });
});
