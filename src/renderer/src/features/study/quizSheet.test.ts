import { describe, expect, it } from "vitest";
import {
  dontKnowPicks,
  editedPicks,
  given,
  handInCount,
  handInPicks,
  restoredMarked,
  toggleMarked,
} from "./quizSheet";

const questions = [
  { id: "a", kind: "mcq" },
  { id: "b", kind: "open" },
  { id: "c", kind: "completion" },
  { id: "d", kind: "matching" },
];

describe("given", () => {
  it("tells an answer from an explicit Non lo so and from nothing", () => {
    expect(given("mcq", "2")).toBe("answer");
    expect(given("mcq", "")).toBe("dontKnow");
    expect(given("mcq", undefined)).toBe("none");
    expect(given("open", "  ")).toBe("none");
    expect(given("completion", JSON.stringify(["", " "]))).toBe("none");
    expect(given("completion", JSON.stringify(["", "6 N"]))).toBe("answer");
    expect(given("matching", JSON.stringify([["F", ""]]))).toBe("none");
    expect(given("matching", JSON.stringify([["F", "ma"]]))).toBe("answer");
  });
});

describe("editedPicks and dontKnowPicks", () => {
  it("drops an answer erased to nothing, so it never reads as Non lo so", () => {
    const typed = editedPicks({}, "b", "open", "x(t) = t^3");
    expect(typed).toEqual({ b: "x(t) = t^3" });
    expect(editedPicks(typed, "b", "open", "")).toEqual({});
    expect(editedPicks({}, "c", "completion", JSON.stringify(["", ""]))).toEqual({});
  });
  it("sets Non lo so as an empty pick and takes it back on a second press", () => {
    const unsure = dontKnowPicks({ a: "1" }, "a");
    expect(unsure).toEqual({ a: "" });
    expect(dontKnowPicks(unsure, "a")).toEqual({});
  });
});

describe("toggleMarked", () => {
  it("keeps the marked questions in question order", () => {
    const order = questions.map((question) => question.id);
    const marked = toggleMarked(toggleMarked([], "d", order), "a", order);
    expect(marked).toEqual(["a", "d"]);
    expect(toggleMarked(marked, "d", order)).toEqual(["a"]);
  });
});

describe("Consegna", () => {
  it("counts blank questions and the ones marked for later", () => {
    const picks = { a: "1", b: "", c: JSON.stringify(["", ""]) };
    // A Non lo so is given; a completion with empty blanks is not.
    expect(handInCount(questions, picks, ["b", "d", "gone"])).toEqual({ given: 2, blank: 2, marked: 2 });
  });
  it("hands in every question, a blank one as an empty pick", () => {
    const picks = { a: "1", c: JSON.stringify(["", ""]) };
    expect(handInPicks(questions, picks)).toEqual({ a: "1", b: "", c: "", d: "" });
  });
  it("handles a quiz of one question and one of forty", () => {
    expect(handInCount([{ id: "only", kind: "tf" }], {}, [])).toEqual({ given: 0, blank: 1, marked: 0 });
    const forty = Array.from({ length: 40 }, (_, index) => ({ id: `q${index}`, kind: "mcq" }));
    const half = Object.fromEntries(forty.slice(0, 20).map((question) => [question.id, "0"]));
    expect(handInCount(forty, half, ["q39"])).toEqual({ given: 20, blank: 20, marked: 1 });
    expect(Object.keys(handInPicks(forty, half))).toHaveLength(40);
  });
});

describe("restoredMarked", () => {
  it("reads the marked list in question order", () => {
    expect(restoredMarked({ marked: ["d", "a"] }, questions)).toEqual(["a", "d"]);
  });
  it("turns an old draft's unanswered skipped questions into marked ones", () => {
    expect(restoredMarked({ skipped: ["c", "a"], picks: { a: "1" } }, questions)).toEqual(["c"]);
    expect(restoredMarked(undefined, questions)).toEqual([]);
  });
});
