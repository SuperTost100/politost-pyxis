/** The part of the day the Home greeting names: morning from 5 to noon, afternoon until 6 pm, evening the rest. */
export type DayPart = "morning" | "afternoon" | "evening";

export function dayPart(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "evening";
}
