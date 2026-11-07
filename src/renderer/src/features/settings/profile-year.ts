/** Years the profile's stepper offers: the first of primary school up to a long university course. */
export const YEAR_RANGE = { min: 1, max: 10 } as const;

/**
 * The stored school year as the stepper's number. The year is free text, since setup asks for it in a field: "2",
 * "2° anno" and "2nd year" all read 2. Text that starts with no number, such as "fuori corso", reads null.
 */
export function yearNumber(year: string | undefined): number | null {
  const match = /^\s*(\d{1,2})(?!\d)/.exec(year ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  return value >= YEAR_RANGE.min && value <= YEAR_RANGE.max ? value : null;
}
