import { describe, expect, it } from "vitest";
import { shouldClose, shouldOpen, type OpenGap } from "./gaps";

const DAY = 86_400_000;

describe("gaps", () => {
  it("opens on two wrong answers and merges into an open gap", () => {
    const attempt = { topicId: "t", at: 1, scores: [0, 0, 1] };
    expect(shouldOpen(attempt, false)).toBe(true);
    expect(shouldOpen(attempt, true)).toBe(false);
    expect(shouldOpen({ topicId: "t", at: 1, scores: [1], openScores: [0.2] }, false)).toBe(true);
  });

  it("closes only after two clean days", () => {
    const gap: OpenGap = { topicId: "t", openedAt: 1_000 };
    const later = [
      { topicId: "t", at: gap.openedAt + DAY, scores: [1] },
      { topicId: "t", at: gap.openedAt + 2 * DAY, scores: [1] },
    ];
    expect(shouldClose(gap, later)).toBe(true);
    expect(
      shouldClose(gap, [
        later[0]!,
        { topicId: "t", at: gap.openedAt + 2 * DAY, scores: [0] },
      ]),
    ).toBe(false);
    expect(shouldClose(gap, [later[0]!])).toBe(false);
  });
});
