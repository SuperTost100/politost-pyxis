import { describe, expect, it } from "vitest";
import { seededRandom, shuffleChoices } from "./choices";

const options = ["a", "b", "c", "d"];

describe("shuffleChoices", () => {
  it("returns a permutation and moves the correct index with its option", () => {
    for (let seed = 0; seed < 50; seed++) {
      for (let correct = 0; correct < options.length; correct++) {
        const shown = shuffleChoices(
          options,
          correct,
          seededRandom(`s${seed}`),
        );
        expect([...shown.options].sort()).toEqual(options);
        expect(shown.options[shown.correct]).toBe(options[correct]);
        expect(shown.order.map((from) => options[from])).toEqual(shown.options);
        expect(shown.order.indexOf(correct)).toBe(shown.correct);
      }
    }
  });

  it("is the same for the same seed and does not change its input", () => {
    const input = [...options];
    const first = shuffleChoices(input, 2, seededRandom("block-1"));
    expect(shuffleChoices(input, 2, seededRandom("block-1"))).toEqual(first);
    expect(input).toEqual(options);
  });

  it("puts the right option in every position across seeds", () => {
    const places = new Set<number>();
    for (let seed = 0; seed < 200; seed++)
      places.add(shuffleChoices(options, 0, seededRandom(`q${seed}`)).correct);
    expect([...places].sort()).toEqual([0, 1, 2, 3]);
  });

  it("handles one, two and unequal option counts", () => {
    expect(shuffleChoices(["x"], 0, seededRandom("a"))).toEqual({
      options: ["x"],
      correct: 0,
      order: [0],
    });
    const two = shuffleChoices(["x", "y"], 1, seededRandom("a"));
    expect(two.options[two.correct]).toBe("y");
  });
});

describe("seededRandom", () => {
  it("is deterministic per seed, differs between seeds and stays in [0, 1)", () => {
    const a = seededRandom("one");
    const b = seededRandom("one");
    const values = Array.from({ length: 20 }, () => a());
    expect(Array.from({ length: 20 }, () => b())).toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom("two")()).not.toBe(values[0]);
  });
});
