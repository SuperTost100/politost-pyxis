import { describe, expect, it } from "vitest";
import { decimalSeparator, formatHours } from "./plannerFormat";

describe("hours in the planner", () => {
  it("writes a half hour with the interface language's decimal mark", () => {
    expect(formatHours("it", 0.5)).toBe("0,5");
    expect(formatHours("it", 3.5)).toBe("3,5");
    expect(formatHours("en", 0.5)).toBe("0.5");
  });

  it("writes whole hours without a decimal", () => {
    expect(formatHours("it", 6)).toBe("6");
    expect(formatHours("en", 1234)).toBe("1,234");
  });

  it("tells the hours field which mark to show and accept", () => {
    expect(decimalSeparator("it")).toBe(",");
    expect(decimalSeparator("en")).toBe(".");
  });
});
