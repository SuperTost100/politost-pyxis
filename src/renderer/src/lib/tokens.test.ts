import { describe, expect, it } from "vitest";
import { cacheShare, formatTokens } from "./tokens";

describe("token figures", () => {
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
