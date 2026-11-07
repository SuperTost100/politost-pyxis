import { describe, expect, it } from "vitest";
import { hasScanFile } from "./scanFile";

describe("a scan's file", () => {
  it("is there as a stored copy, or as a linked file the folder still holds", () => {
    expect(hasScanFile({ blobSha: "abc" })).toBe(true);
    expect(hasScanFile({ blobSha: null, linked: { missing: false } })).toBe(true);
    expect(hasScanFile({ blobSha: null, linked: { missing: true } })).toBe(false);
    expect(hasScanFile({ blobSha: null, linked: null })).toBe(false);
    expect(hasScanFile({ blobSha: null })).toBe(false);
  });
});
