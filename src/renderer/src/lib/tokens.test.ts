import { describe, expect, it } from "vitest";
import { cacheShare, formatTokens, weekStart } from "./tokens";

describe("token figures", () => {
  it("starts the week on Monday at local midnight", () => {
    expect(weekStart(new Date(2026, 9, 17, 15, 30))).toEqual(new Date(2026, 9, 12));
    expect(weekStart(new Date(2026, 9, 12, 0, 0))).toEqual(new Date(2026, 9, 12));
    // A Sunday belongs to the week that began six days earlier.
    expect(weekStart(new Date(2026, 9, 18, 23, 59))).toEqual(new Date(2026, 9, 12));
    // The week of the October daylight-saving change in Italy.
    expect(weekStart(new Date(2026, 10, 1, 12))).toEqual(new Date(2026, 9, 26));
  });

  it("writes counts in full or short, in the app's language", () => {
    expect(formatTokens(12400, "en")).toBe("12,400");
    expect(formatTokens(12400, "it")).toBe("12.400");
    expect(formatTokens(12400, "en", true)).toBe("12.4K");
    expect(formatTokens(950, "en", true)).toBe("950");
  });

  it("gives the cache share only when the cache served something", () => {
    expect(cacheShare({ inputTokens: 1000, cacheReadTokens: 650 })).toBe(65);
    expect(cacheShare({ inputTokens: 1000, cacheReadTokens: 0 })).toBeNull();
    expect(cacheShare({ inputTokens: 0, cacheReadTokens: 0 })).toBeNull();
  });
});
