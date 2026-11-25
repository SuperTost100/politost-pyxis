import { describe, expect, it } from "vitest";
import { hasScanFile, scanFoundNothing } from "./scanFile";

describe("a scan's file", () => {
  it("is there as a stored copy, or as a linked file the folder still holds", () => {
    expect(hasScanFile({ blobSha: "abc" })).toBe(true);
    expect(hasScanFile({ blobSha: null, linked: { missing: false } })).toBe(true);
    expect(hasScanFile({ blobSha: null, linked: { missing: true } })).toBe(false);
    expect(hasScanFile({ blobSha: null, linked: null })).toBe(false);
    expect(hasScanFile({ blobSha: null })).toBe(false);
  });
});

describe("a scan whose OCR found no text", () => {
  const source = { kind: "pdf", status: "failed", sections: 0, blobSha: "abc" };

  it("is a Word file or deck as well as a PDF, so the notice can offer to read it again", () => {
    for (const kind of ["pdf", "docx", "pptx"]) expect(scanFoundNothing({ ...source, kind })).toBe(true);
    expect(scanFoundNothing({ ...source, kind: "text" })).toBe(false);
  });

  it("is not a failed import, which names its error", () => {
    expect(scanFoundNothing({ ...source, kind: "docx", error: "archive-too-large" })).toBe(false);
  });
});
