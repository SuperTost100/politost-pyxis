import { describe, expect, it } from "vitest";
import { retryPick, skipOrder } from "./quizText";

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
