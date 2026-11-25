/**
 * Grades, goals and mastery are stored as fractions from 0 to 1. The student sees them out of 30, as Italian
 * universities mark exams, or out of 100. Nothing stored changes with the scale. The window formats them through
 * `renderer/src/lib/grade.ts`; core uses the same numbers where it tells a model what the student sees.
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
