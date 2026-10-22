import { describe, expect, it } from "vitest";
import { safeFileName } from "./file-name";

describe("safeFileName", () => {
  it("replaces characters Windows refuses and control characters", () => {
    expect(safeFileName('Fisica: 1/2 "moti"?\u0007', "x")).toBe("Fisica 1 2 moti");
    expect(safeFileName("a\tb\nc", "x")).toBe("a b c");
  });

  it("cuts at the limit without splitting an emoji, and falls back when nothing is left", () => {
    expect(safeFileName(`${"a".repeat(9)}😀b`, "x", 10)).toBe(`${"a".repeat(9)}😀`);
    expect(safeFileName(' <>|*? ', "export")).toBe("export");
  });
});
