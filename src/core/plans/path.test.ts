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
    const topics = [topic("a", 0.4), topic("b"), topic("c")];
    const steps = [step("intro"), step("diagnostic"), step("lesson", "a"), step("practice", "a")];
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
    // Every topic read: the weakest one gets the exercise.
    const all = [topic("a", 0.7), topic("b", 0.3)];
    expect(
      suggestStep({
        ...base,
        topics: all,
        steps: [step("lesson", "a"), step("lesson", "b"), step("quiz", "b")],
      }),
    ).toMatchObject({ activity: "practice", topicId: "b", reason: "weakest" });
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
