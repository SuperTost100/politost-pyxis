import { expect, it } from "vitest";
import { pageRanges } from "./pageRanges";

it("joins runs of consecutive pages and keeps single pages apart", () => {
  expect(pageRanges([])).toBe("");
  expect(pageRanges([4])).toBe("4");
  expect(pageRanges([41, 42, 43, 44, 45, 46])).toBe("41–46");
  expect(pageRanges([3, 7, 8, 9, 12])).toBe("3, 7–9, 12");
  expect(pageRanges([1, 2, 4, 5])).toBe("1–2, 4–5");
});
