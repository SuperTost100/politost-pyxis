/** Calendar days in the computer's own time zone, as the student lives them. A day is not always 24 hours long. */

/** A number as at least two digits, as dates and times are written. */
export const two = (n: number) => String(n).padStart(2, "0");

/** Local midnight at the start of the day `at` falls on. */
export function startOfDay(at: number | Date): number {
  return new Date(at).setHours(0, 0, 0, 0);
}

/** Local midnight `days` calendar days after the day `at` falls on (before it when negative). */
export function addDays(at: number | Date, days: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** Local midnight on the Monday of the week `at` falls in. */
export function startOfWeek(at: number | Date): number {
  return addDays(at, -((new Date(at).getDay() + 6) % 7));
}

/** Calendar days from the day `from` falls on to the day `to` falls on; negative when `to` is earlier. */
export function daysBetween(from: number | Date, to: number | Date): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86_400_000);
}

/** The local date as `2026-10-17`. */
export function dayKey(at: number | Date): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
