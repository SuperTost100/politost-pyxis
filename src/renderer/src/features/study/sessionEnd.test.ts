import { describe, expect, it } from "vitest";
import { barShare, countdownText, groupSeen, minutesLeft, rateCounts, type SeenCard } from "./sessionEnd";

const card = (cardId: string, rating: SeenCard["rating"], reviewId = `${cardId}-${rating}`): SeenCard => ({
  cardId,
  reviewId,
  rating,
  front: `Front of ${cardId}`,
  subject: null,
});

describe("session end", () => {
  const seen = [card("a", "good"), card("b", "again"), card("c", "good"), card("a", "easy", "a-2"), card("d", "hard")];

  it("counts each answer, the ones nobody gave as zero", () => {
    expect(rateCounts(seen)).toEqual({ again: 1, hard: 1, good: 2, easy: 1 });
    expect(rateCounts([])).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
  });

  it("lists the cards under the answer given, in the order of the answers, and skips an answer nobody gave", () => {
    expect(groupSeen(seen, new Set()).map((group) => [group.rating, group.cards.map((item) => item.cardId)])).toEqual([
      ["again", ["b"]],
      ["hard", ["d"]],
      ["good", ["a", "c"]],
      ["easy", ["a"]],
    ]);
    expect(groupSeen(seen.filter((item) => item.rating !== "again"), new Set()).map((group) => group.rating)).toEqual([
      "hard",
      "good",
      "easy",
    ]);
  });

  it("leaves out only the latest answer of a card that is waiting to come back", () => {
    const groups = groupSeen(seen, new Set(["a"]));
    // `a` was answered twice: its first answer stays under "good", its latest is the one that sent it back.
    expect(groups.find((group) => group.rating === "good")!.cards.map((item) => item.cardId)).toEqual(["a", "c"]);
    expect(groups.find((group) => group.rating === "easy")).toBeUndefined();
  });

  it("fills the bar of the most given answer and scales the others", () => {
    const counts = rateCounts(seen);
    expect(barShare(2, counts)).toBe(1);
    expect(barShare(1, counts)).toBe(0.5);
    expect(barShare(0, { again: 0, hard: 0, good: 0, easy: 0 })).toBe(0);
  });

  it("writes the countdown as m:ss, and h:mm:ss from an hour", () => {
    expect(countdownText(342_000)).toBe("5:42");
    expect(countdownText(341_100)).toBe("5:42");
    expect(countdownText(59_000)).toBe("0:59");
    expect(countdownText(0)).toBe("0:00");
    expect(countdownText(-5_000)).toBe("0:00");
    expect(countdownText(3_725_000)).toBe("1:02:05");
  });

  it("rounds the minutes up and never says less than one", () => {
    expect(minutesLeft(6 * 60_000)).toBe(6);
    expect(minutesLeft(5 * 60_000 + 1)).toBe(6);
    expect(minutesLeft(10_000)).toBe(1);
    expect(minutesLeft(-10_000)).toBe(1);
  });
});
