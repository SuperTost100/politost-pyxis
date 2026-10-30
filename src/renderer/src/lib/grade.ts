/**
 * Grades, goals and mastery are stored as fractions from 0 to 1. The student sees them out of 30, as Italian
 * universities mark exams, or out of 100. Nothing stored changes with the scale. These functions are pure, so unit
 * tests can import them; `useGradeScale` in `useGradeScale.ts` applies them to the profile's scale.
 */
export type GradeScale = 30 | 100;
export const gradeScales: readonly GradeScale[] = [30, 100];

/** The scale for a profile that never picked one: out of 30 at university, out of 100 at every other level. */
export function defaultGradeScale(level: string | undefined): GradeScale {
  return (level ?? "university") === "university" ? 30 : 100;
}

/** The profile's scale: the one the student picked, or the default for their study level. No profile reads as university. */
export function gradeScaleOf(
  profile:
    | { gradeScale?: GradeScale | null; educationLevel?: string }
    | null
    | undefined,
): GradeScale {
  return profile?.gradeScale ?? defaultGradeScale(profile?.educationLevel);
}

/**
 * A fraction on the scale: one decimal out of 30, whole numbers out of 100. It rounds down, so a grade never shows a
 * mark the student has not reached: 0.599 out of 30 is 17,9, not the pass mark 18. The small tolerance keeps floating
 * point from taking a step away (0.57 × 30 is 17.0999…, and reads 17,1).
 */
export function gradeValue(fraction: number, scale: GradeScale): number {
  const clamped = Math.max(0, Math.min(1, fraction));
  const steps = scale === 30 ? 10 : 1;
  return Math.floor(clamped * scale * steps + 1e-9) / steps;
}

/**
 * A fraction as a whole number on the scale, rounded down: 18,6 out of 30 is 18, and 29,99 is 29. The path bars use it
 * so a topic never looks at its goal before it is. Grades and goals that are precise (results, the goal itself) keep
 * `gradeValue`. The tolerance matches `gradeValue`'s.
 */
export function gradeWhole(fraction: number, scale: GradeScale): number {
  return Math.floor(Math.max(0, Math.min(1, fraction)) * scale + 1e-9);
}

/**
 * A fraction's exact position on the scale (22,8 out of 30), for chart coordinates. Nothing is rounded, so a point never
 * lands under a goal it has passed; the numbers the student reads go through `gradeWhole` or `gradeValue`.
 */
export function scaledMastery(fraction: number, scale: GradeScale): number {
  return Math.max(0, Math.min(1, fraction)) * scale;
}

/** A change between two fractions (a weekly gain, a decay) in the scale's points, to the nearest step. */
export function gradeDelta(delta: number, scale: GradeScale): number {
  const steps = scale === 30 ? 10 : 1;
  const value = Math.round(Math.max(-1, Math.min(1, delta)) * scale * steps) / steps;
  return value === 0 ? 0 : value;
}

/** A number with the language's decimal mark: "22,5" in Italian, "22.5" in English. */
export function formatGradeNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

/** A fraction as the student reads it: "18/30", "22,5/30" or "75/100". */
export function formatGrade(fraction: number, scale: GradeScale, locale: string): string {
  return `${formatGradeNumber(gradeValue(fraction, scale), locale)}/${scale}`;
}

/** A fraction as a whole mastery on the scale: "18/30" for 18,6 out of 30. */
export function formatGradeWhole(fraction: number, scale: GradeScale): string {
  return `${gradeWhole(fraction, scale)}/${scale}`;
}

/** A change with its sign: "+1,5", "−3" or "0". */
export function formatGradeDelta(delta: number, scale: GradeScale, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(gradeDelta(delta, scale));
}

/**
 * The goal input on each scale. Out of 30 a goal starts at 18, the pass mark, and moves one mark at a time. Out of 100
 * it keeps the range a stored goal allows (0.5 to 1) in steps of 5.
 */
export function goalRange(scale: GradeScale): {
  min: number;
  max: number;
  step: number;
  marks: number[];
} {
  return scale === 30
    ? { min: 18, max: 30, step: 1, marks: [18, 22, 26, 30] }
    : { min: 50, max: 100, step: 5, marks: [60, 75, 90] };
}

/** A stored goal as the input's value: on the scale, whole, and inside the input's range. */
export function goalInput(fraction: number, scale: GradeScale): number {
  const { min, max } = goalRange(scale);
  return Math.max(min, Math.min(max, Math.round(fraction * scale)));
}

/** The input's value back to the stored fraction, inside the 0.5 to 1 a goal may be. */
export function goalFraction(value: number, scale: GradeScale): number {
  const { min, max } = goalRange(scale);
  const fraction = Math.max(min, Math.min(max, value)) / scale;
  return Math.max(0.5, Math.min(1, fraction));
}

/** The goal a new exam starts with: the stored default of 0.75, so 75/100 or 23/30. */
export function defaultGoal(scale: GradeScale): number {
  return goalInput(0.75, scale);
}
