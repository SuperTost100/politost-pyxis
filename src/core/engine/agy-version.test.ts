import { describe, expect, it } from "vitest";
import { AGY_MIN_VERSION, tooOld } from "./agy-version";

describe("an Antigravity program too old for cli-funnel 1.0", () => {
  it("is one before 1.5.0, whatever the digits", () => {
    expect(AGY_MIN_VERSION).toBe("1.5.0");
    for (const old of ["1.4.0", "1.4.7", "1.2.0", "1.3.0", "0.9.0", "1.4.99", "agy 1.4.7"]) expect(tooOld("antigravity", old), old).toBe(true);
  });

  it("is not one from 1.5.0 on, including a two-digit minor", () => {
    for (const fine of ["1.5.0", "1.5.13", "1.6.0", "1.10.0", "2.0.0", "agy 1.5.0 (build 4)"]) expect(tooOld("antigravity", fine), fine).toBe(false);
  });

  it("is not read from a version that is missing or unreadable, or for another tool", () => {
    expect(tooOld("antigravity", "")).toBe(false);
    expect(tooOld("antigravity", undefined)).toBe(false);
    expect(tooOld("antigravity", "unknown")).toBe(false);
    expect(tooOld("claude", "1.0.0")).toBe(false);
  });
});
