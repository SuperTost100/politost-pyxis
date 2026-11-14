import { describe, expect, it } from "vitest";
import { barLine, cardsLine, exerciseMix, practiceLine, quizLine } from "./barLines";

// A translation that shows the key and its values, so a test reads what the line is made of.
const key = (name: string, values?: Record<string, unknown>) => (values ? `${name}${JSON.stringify(values)}` : name);
const dot = " \u00b7 ";

describe("a bar line", () => {
  it("joins its pieces with a middle dot and leaves out the ones that are not there", () => {
    expect(barLine(["Quiz", null, undefined, false, "Fisica"])).toBe(`Quiz${dot}Fisica`);
    expect(barLine([null, undefined])).toBe("");
  });
});

describe("the quiz's line", () => {
  const base = { stage: "questions", kept: false, position: { current: 3, total: 10 }, timerMinutes: null } as const;

  it("says which question this is and that the time is not limited", () => {
    expect(quizLine(key, base)).toBe(`quiz.title${dot}quiz.barPosition{"current":3,"total":10}, quiz.sheet.untimed`);
  });

  it("says the time limit of a timed quiz", () => {
    expect(quizLine(key, { ...base, timerMinutes: 20 })).toBe(
      `quiz.title${dot}quiz.barPosition{"current":3,"total":10}, quiz.sheet.minutes{"count":20}`,
    );
  });

  it("leaves out the question while the questions are still being read", () => {
    expect(quizLine(key, { ...base, position: null })).toBe(`quiz.title${dot}quiz.sheet.untimed`);
  });

  it("says that a diagnostic's or a Ripasso's answers are kept, in place of the position", () => {
    expect(quizLine(key, { ...base, kept: true })).toBe("quiz.keptLine");
  });

  it("puts a Ripasso's place over its cards and questions before that", () => {
    expect(quizLine(key, { ...base, kept: true, overall: { current: 6, total: 13 } })).toBe(
      `cards.reviewPosition{"current":6,"total":13}${dot}quiz.keptLine`,
    );
  });

  it("names the exam on the intro and the results on the results", () => {
    expect(quizLine(key, { ...base, stage: "intro", exam: "Analisi 2" })).toBe(`quiz.title${dot}Analisi 2`);
    expect(quizLine(key, { ...base, stage: "intro" })).toBe("quiz.title");
    expect(quizLine(key, { ...base, stage: "results", kept: true })).toBe(`quiz.title${dot}results.title`);
  });
});

describe("the exercises' line", () => {
  it("tells where a set comes from", () => {
    expect(exerciseMix([])).toBeNull();
    expect(exerciseMix([{ generated: false }, { generated: false }])).toBe("book");
    expect(exerciseMix([{ generated: true }])).toBe("ai");
    expect(exerciseMix([{ generated: true }, { generated: false }])).toBe("mixed");
  });

  it("counts the exercises and names their source, unless they have two", () => {
    expect(practiceLine(key, [{ generated: false }, { generated: false }])).toBe(
      `places.practice${dot}practice.barCount{"count":2}, practice.barBook`,
    );
    expect(practiceLine(key, [{ generated: true }])).toBe(`places.practice${dot}practice.barCount{"count":1}, practice.barAi`);
    expect(practiceLine(key, [{ generated: true }, { generated: false }])).toBe(
      `places.practice${dot}practice.barCount{"count":2}`,
    );
    expect(practiceLine(key, [])).toBe("places.practice");
  });
});

describe("the flashcards' line", () => {
  it("shows the card of the session, and the place when the session mixes several", () => {
    expect(cardsLine(key, { at: 4, total: 12 })).toBe(`cards.title${dot}cards.sessionProgress{"done":4,"total":12}`);
    expect(cardsLine(key, { place: "Analisi 2", at: 1, total: 3 })).toBe(
      `cards.title${dot}Analisi 2${dot}cards.sessionProgress{"done":1,"total":3}`,
    );
    expect(cardsLine(key, { at: 0, total: 0 })).toBe("cards.title");
  });
});
