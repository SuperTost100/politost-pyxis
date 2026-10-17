import { describe, expect, it } from "vitest";
import { skipOrder } from "./quizText";

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
