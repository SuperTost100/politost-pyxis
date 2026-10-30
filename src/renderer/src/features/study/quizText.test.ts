import { describe, expect, it } from "vitest";
import { retryPick, skipOrder, verdictLine } from "./quizText";

const questions = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe("skipOrder", () => {
  it("keeps the order when nothing is skipped", () => {
    expect(ids(skipOrder(questions, []))).toEqual(["a", "b", "c", "d"]);
  });
  it("puts skipped questions after the others, in the order they were skipped", () => {
    expect(ids(skipOrder(questions, ["c", "a"]))).toEqual(["b", "d", "c", "a"]);
  });
  it("ignores skipped ids that are not (yet) in the quiz", () => {
    expect(ids(skipOrder(questions.slice(0, 2), ["z", "a"]))).toEqual(["b", "a"]);
  });
});

describe("retryPick", () => {
  it("resends the failed pick when the answer was not touched", () => {
    expect(retryPick("", "", "")).toBe("");
    expect(retryPick("42", "42", "42")).toBe("42");
  });
  it("keeps an \"I don't know\" that failed even when an earlier draft is still in the field", () => {
    expect(retryPick("", "draft", "draft")).toBe("");
  });
  it("sends the edited answer after a failed check", () => {
    expect(retryPick("", "", "new answer")).toBe("new answer");
    expect(retryPick("old", "old", "new")).toBe("new");
  });
});

describe("verdictLine", () => {
  it("tells a diagnostic far under the goal where to start", () => {
    expect(verdictLine(23, true)).toBe("quiz.verdictStart");
    // 15 out of 30 against a goal of 27 is far from it, not "almost there".
    expect(verdictLine(50, true, 90)).toBe("quiz.verdictStart");
  });
  it("never ends a topic quiz with the diagnostic's line", () => {
    expect(verdictLine(23, false)).toBe("quiz.verdictLow");
    expect(verdictLine(0, false)).toBe("quiz.verdictLow");
    expect(verdictLine(50, false, 90)).toBe("quiz.verdictLow");
  });
  it("says the goal is reached at the goal, and almost there within ten points of it", () => {
    for (const diagnostic of [true, false]) {
      expect(verdictLine(75, diagnostic)).toBe("quiz.verdictGreat");
      expect(verdictLine(90, diagnostic, 90)).toBe("quiz.verdictGreat");
      expect(verdictLine(65, diagnostic)).toBe("quiz.verdictClose");
      expect(verdictLine(80, diagnostic, 90)).toBe("quiz.verdictClose");
      expect(verdictLine(79, diagnostic, 90)).toBe("quiz.verdictGood");
    }
  });
  it("compares the exact score with the exact goal, so 74.6% against 75% is not the goal", () => {
    expect(verdictLine(74.6, false, 75)).toBe("quiz.verdictClose");
    expect(verdictLine(74.6, true, 75)).toBe("quiz.verdictClose");
    // A sum of partial credits can land a hair under the percentage it stands for.
    expect(verdictLine(90 - 1e-12, false, 90)).toBe("quiz.verdictGreat");
  });
  it("calls a score over 60% of the goal a good base", () => {
    expect(verdictLine(50, true)).toBe("quiz.verdictGood");
    expect(verdictLine(54, false, 90)).toBe("quiz.verdictGood");
    expect(verdictLine(44, false)).toBe("quiz.verdictLow");
  });
});
