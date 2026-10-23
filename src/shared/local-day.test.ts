import { expect, it } from "vitest";
import { addDays, dayKey, daysBetween, startOfDay, startOfWeek, two } from "./local-day";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

it("works in local calendar days across months, years and weeks", () => {
  expect(startOfDay(at(2026, 10, 17, 22, 30))).toBe(at(2026, 10, 17));
  expect(addDays(at(2026, 12, 31, 15), 1)).toBe(at(2027, 1, 1));
  expect(addDays(at(2026, 3, 1, 9), -1)).toBe(at(2026, 2, 28));
  // Sunday belongs to the week that started on the Monday before it.
  expect(startOfWeek(at(2026, 10, 18, 12))).toBe(at(2026, 10, 12));
  expect(startOfWeek(at(2026, 10, 12, 8))).toBe(at(2026, 10, 12));
  expect(daysBetween(at(2026, 10, 17, 23), at(2026, 10, 18, 1))).toBe(1);
  expect(daysBetween(at(2026, 10, 18), at(2026, 10, 17))).toBe(-1);
  // A day that changes the clock is still one day.
  expect(daysBetween(at(2026, 3, 28, 12), at(2026, 3, 30, 12))).toBe(2);
  expect(dayKey(at(2026, 1, 5))).toBe("2026-01-05");
  expect(dayKey(new Date(2026, 10, 9))).toBe("2026-11-09");
  expect(two(7)).toBe("07");
});
