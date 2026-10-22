import { describe, expect, it } from "vitest";
import { searchMatcher } from "./search";

describe("searchMatcher", () => {
  it("finds a title whatever its accents, case and apostrophes", () => {
    expect(searchMatcher("perche")("Perché il cielo è blu")).toBe(true);
    expect(searchMatcher("PERCHÉ")("perche no")).toBe(true);
    expect(searchMatcher("dell'energia")("Conservazione dell’energia")).toBe(true);
    expect(searchMatcher("  analisi ")("Analisi 1")).toBe(true);
  });

  it("matches everything when nothing is typed, and nothing that is missing", () => {
    expect(searchMatcher("")("Fisica")).toBe(true);
    expect(searchMatcher("   ")("Fisica")).toBe(true);
    expect(searchMatcher("chimica")("Fisica")).toBe(false);
  });
});
