import { describe, expect, it } from "vitest";
import { cardOffer } from "./reviewOffer";

describe("the Review's flashcard offer", () => {
  it("drops the count choice only once the plan is known to have no card due", () => {
    expect(cardOffer(0)).toEqual({ choice: false, noneDue: true });
    expect(cardOffer(3)).toEqual({ choice: true, noneDue: false });
    // Still loading, or the count failed: the choice stays, and nothing claims there are none.
    expect(cardOffer(undefined)).toEqual({ choice: true, noneDue: false });
  });
});
