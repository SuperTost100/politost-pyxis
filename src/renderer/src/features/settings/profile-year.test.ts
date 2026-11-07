import { describe, expect, it } from "vitest";
import { yearNumber } from "./profile-year";

describe("yearNumber", () => {
  it("reads the number a year starts with", () => {
    expect(yearNumber("2")).toBe(2);
    expect(yearNumber(" 2° anno")).toBe(2);
    expect(yearNumber("3rd year")).toBe(3);
    expect(yearNumber("10")).toBe(10);
  });

  it("reads null for no year, text without a leading number, or a number out of range", () => {
    expect(yearNumber(undefined)).toBeNull();
    expect(yearNumber("")).toBeNull();
    expect(yearNumber("fuori corso")).toBeNull();
    expect(yearNumber("0")).toBeNull();
    expect(yearNumber("11")).toBeNull();
    expect(yearNumber("2024")).toBeNull();
  });
});
