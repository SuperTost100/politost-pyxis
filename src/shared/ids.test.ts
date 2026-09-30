import { describe, expect, it } from "vitest";
import { uuidv7 } from "./ids";

describe("uuidv7", () => {
  it("sorts by time and stays unique", () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_000_001);
    expect(earlier < later).toBe(true);
    expect(earlier).not.toBe(uuidv7(1_700_000_000_000));
    expect(earlier[14]).toBe("7");
  });
});
