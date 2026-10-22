import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("writes decimal units with one decimal at most, in the interface language", () => {
    expect(formatBytes(999, "en")).toMatch(/^999\sbyte$/);
    expect(formatBytes(2048, "en")).toMatch(/^2\skB$/);
    expect(formatBytes(1_500_000, "it")).toMatch(/^1,5\sMB$/);
    expect(formatBytes(350_400_000, "en")).toMatch(/^350\.4\sMB$/);
    expect(formatBytes(8.1e9, "en")).toMatch(/^8\.1\sGB$/);
  });

  it("stops at gigabytes", () => {
    expect(formatBytes(2.5e12, "en")).toMatch(/^2,500\sGB$/);
  });
});
