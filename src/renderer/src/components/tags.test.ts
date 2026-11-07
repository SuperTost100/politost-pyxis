import { describe, expect, it } from "vitest";
import { addTags } from "./tags";

const limits = { max: 3, maxLength: 5 };

describe("addTags", () => {
  it("adds each comma-separated item, trimmed, and skips empty ones", () => {
    expect(addTags(["cinema"], " chess , ,go ", { max: 20, maxLength: 60 })).toEqual(["cinema", "chess", "go"]);
  });

  it("skips repeats in any case, among the new items too", () => {
    expect(addTags(["Chess"], "chess, go, GO", { max: 20, maxLength: 60 })).toEqual(["Chess", "go"]);
  });

  it("cuts an item to the longest allowed and stops at the most items allowed", () => {
    expect(addTags([], "football, tennis, golf, rugby", limits)).toEqual(["footb", "tenni", "golf"]);
    expect(addTags(["a", "b", "c"], "d", limits)).toEqual(["a", "b", "c"]);
  });
});
