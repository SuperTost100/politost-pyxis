import { describe, expect, it } from "vitest";
import { dayPart } from "./greeting";

describe("dayPart", () => {
  it("names the morning from 5 to noon, the afternoon until 6 pm and the evening through the night", () => {
    expect([0, 4, 5, 11, 12, 17, 18, 23].map(dayPart)).toEqual([
      "evening",
      "evening",
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
      "evening",
    ]);
  });
});
