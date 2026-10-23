import { describe, expect, it } from "vitest";
import { deadlineCheckDelay } from "./clock";

describe("deadlineCheckDelay", () => {
  it("waits until the deadline, and stops once it has passed", () => {
    expect(deadlineCheckDelay(10_000, 4_000)).toBe(6_000);
    expect(deadlineCheckDelay(10_000, 10_000)).toBeNull();
    expect(deadlineCheckDelay(10_000, 12_000)).toBeNull();
  });

  it("caps a far deadline at the longest delay a timer takes", () => {
    expect(deadlineCheckDelay(40 * 86_400_000, 0)).toBe(2 ** 31 - 1);
  });
});
