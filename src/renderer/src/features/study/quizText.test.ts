import { describe, expect, it } from "vitest";
import { answerSource, questionPoints, skipOrder, verdict, verdictLine } from "./quizText";

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

describe("answerSource", () => {
  it("reads an open answer as the math editor's text and a fill-in blank as the raw text of a plain input", () => {
    expect(answerSource("open")).toBe("math");
    expect(answerSource("completion")).toBe("plain");
  });

  it("has none for a question answered by picking, whose text is the model's", () => {
    for (const kind of ["mcq", "tf", "matching", "exercise"]) expect(answerSource(kind)).toBeUndefined();
  });
});

describe("one question's credit", () => {
  it("is written as points of that question, one decimal, in the interface language", () => {
    expect(questionPoints(0.55, "it")).toBe("0,6");
    expect(questionPoints(0.5, "en")).toBe("0.5");
    expect(questionPoints(1, "it")).toBe("1");
  });

  it("never shows a score under 1 as 1, which would sit beside a partial verdict", () => {
    expect(questionPoints(0.95, "it")).toBe("0,9");
    expect(questionPoints(0.96, "en")).toBe("0.9");
  });

  it("is right at full credit, partial in between, wrong at zero", () => {
    expect([1, 0.5, 0].map(verdict)).toEqual(["correct", "partial", "wrong"]);
  });
});
