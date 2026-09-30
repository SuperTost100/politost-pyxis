import { describe, expect, it } from "vitest";
import { reachableTarget } from "../../shared/plan-file";
import { pathState, recommend, type PathNode } from "./path";

const nodes: PathNode[] = [
  { id: "intro", stage: "intro", topicId: null, position: 0 },
  { id: "diag", stage: "diagnostic", topicId: null, position: 1 },
  { id: "learn-a", stage: "learn", topicId: "a", position: 2 },
  { id: "learn-b", stage: "learn", topicId: "b", position: 3 },
  { id: "final", stage: "final", topicId: null, position: 4 },
];

describe("pathState", () => {
  it("opens the introduction and locks the rest", () => {
    const states = pathState(nodes, [], { a: 0, b: 0 });
    expect(states.find((item) => item.id === "intro")?.state).toBe("current");
    expect(states.find((item) => item.id === "diag")?.state).toBe("locked");
    expect(states.find((item) => item.id === "final")?.reason).toBe("plans.unlocksAtTarget");
  });

  it("unlocks the next topic after the previous one reaches half", () => {
    const states = pathState(nodes, ["intro", "diag"], { a: 0.5, b: 0.2 }, 0.8);
    expect(states.find((item) => item.id === "learn-a")?.state).toBe("current");
    expect(states.find((item) => item.id === "learn-b")?.state).toBe("locked");
    const opened = pathState(nodes, ["intro", "diag", "learn-a"], { a: 0.6, b: 0.2 });
    expect(opened.find((item) => item.id === "learn-b")?.state).toBe("current");
  });

  it("lets a 100% target open after a miss", () => {
    const done = ["intro", "diag", "learn-a", "learn-b"];
    const mastery = { a: 0.99, b: 0.99 };
    expect(pathState(nodes, done, mastery, 1).find((item) => item.id === "final")?.state).toBe(
      "locked",
    );
    expect(
      pathState(nodes, done, mastery, reachableTarget(1)).find((item) => item.id === "final")?.state,
    ).toBe("current");
  });
});

describe("recommend", () => {
  it("ranks due cards above an idle topic", () => {
    const due = recommend({
      dueCards: 3,
      severeGaps: 1,
      topicMastery: 0.4,
      target: 0.8,
      daysToExam: 10,
      daysIdle: 0,
      styleMatch: 0,
    });
    const idle = recommend({
      dueCards: 0,
      severeGaps: 0,
      topicMastery: 0.7,
      target: 0.8,
      daysToExam: 10,
      daysIdle: 2,
      styleMatch: 0,
    });
    expect(due.score).toBeGreaterThan(idle.score);
    expect(due.reason).toBe("3 cards due");
    expect(due.score).toBeCloseTo(3 * 3 + 4 * 1 + 2 * 0.4 * (1 + 2 / 10));
  });
});
