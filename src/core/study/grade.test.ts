import { describe, expect, it } from "vitest";
import { gradeAnswer } from "./grade";
import { answerOf } from "./attempt";

describe("gradeAnswer", () => {
  it("treats malformed completion picks as unanswered", () => {
    const expected = { kind: "completion" as const, answers: [], accepted: [["10"]] };
    for (const pick of [[null], [10], [{}], ["10", null]])
      expect(gradeAnswer(answerOf(expected, pick))).toBe(0);
    expect(gradeAnswer(answerOf(expected, ["10"]))).toBe(1);
  });
  it("grades closed questions locally", () => {
    expect(gradeAnswer({ kind: "mcq", picked: 2, correct: 2 })).toBe(1);
    expect(gradeAnswer({ kind: "mcq", picked: 0, correct: 2 })).toBe(0);
    expect(gradeAnswer({ kind: "tf", picked: false, correct: false })).toBe(1);
    expect(
      gradeAnswer({
        kind: "matching",
        pairs: [
          ["forza", "newton"],
          ["energia", "joule"],
        ],
        correct: [
          ["Forza", "Newton"],
          ["energia", "joule"],
        ],
      }),
    ).toBe(1);
  });

  it("accepts accents and numbers within one percent", () => {
    expect(
      gradeAnswer({
        kind: "completion",
        answers: ["velocita", "9.9"],
        accepted: [["velocità"], ["10"]],
      }),
    ).toBe(1);
    expect(
      gradeAnswer({
        kind: "completion",
        answers: ["12"],
        accepted: [["10"]],
      }),
    ).toBe(0);
    expect(
      gradeAnswer({
        kind: "completion",
        answers: [""],
        accepted: [["0"]],
      }),
    ).toBe(0);
    // Whole numbers match exactly: a year or a count is right or wrong.
    expect(
      gradeAnswer({
        kind: "completion",
        answers: ["1860", "1848"],
        accepted: [["1848"], ["1848"]],
      }),
    ).toBe(0.5);
    expect(
      gradeAnswer({ kind: "open", answer: "1849", reference: "1848" }),
    ).toBe(0);
    // Small values get the same 1% relative tolerance, not 0.01 absolute.
    const close = (answer: string, reference: string) =>
      gradeAnswer({ kind: "completion", answers: [answer], accepted: [[reference]] });
    expect(close("0", "0.004")).toBe(0);
    expect(close("0.009", "0.002")).toBe(0);
    expect(close("0.49", "0.504")).toBe(0);
    expect(close("0.5", "0.504")).toBe(1);
    expect(close("0.00201", "0.002")).toBe(1);
    expect(close("6.62e-34", "6.626e-34")).toBe(1);
    expect(close("0", "6.626e-34")).toBe(0);
    expect(close("0.0", "0")).toBe(1);
    expect(close("1e-12", "0")).toBe(1);
    expect(close("0.001", "0")).toBe(0);
    expect(
      gradeAnswer({
        kind: "matching",
        pairs: [
          ["a", "1"],
          ["a", "1"],
          ["a", "1"],
          ["a", "1"],
        ],
        correct: [
          ["a", "1"],
          ["b", "2"],
          ["c", "3"],
        ],
      }),
    ).toBeCloseTo(1 / 3);
    expect(
      gradeAnswer({
        kind: "matching",
        pairs: [
          ["a", "1"],
          ["a", "1"],
          ["b", "2"],
        ],
        correct: [
          ["a", "1"],
          ["a", "1"],
          ["b", "2"],
        ],
      }),
    ).toBe(1);
    expect(
      gradeAnswer({
        kind: "matching",
        pairs: [[null as unknown as string, "1"]],
        correct: [["a", "1"]],
      }),
    ).toBe(0);
    expect(
      gradeAnswer({
        kind: "matching",
        pairs: [["a", "b=c"]],
        correct: [["a=b", "c"]],
      }),
    ).toBe(0);
  });
});
