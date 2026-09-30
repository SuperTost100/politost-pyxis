import { describe, expect, it } from "vitest";
import { gradeAnswer } from "./grade";

describe("gradeAnswer", () => {
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
  });
});
