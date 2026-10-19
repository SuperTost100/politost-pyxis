type T = (key: string, params?: Record<string, unknown>) => string;

/** Study time as "45 min", "2 h" or "1 h 30 min". */
export function formatMinutes(t: T, minutes: number): string {
  const rounded = Math.round(minutes / 5) * 5;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (hours === 0) return t("planner.minutes", { count: rest });
  if (rest === 0) return t("planner.hours", { count: hours });
  return t("planner.hoursMinutes", { hours, minutes: rest });
}

/** A planner date (YYYY-MM-DD, local) as a Date at local midnight. */
export function plannerDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

/** The falling-behind warning for one exam. */
export function behindText(
  t: T,
  exam: {
    title: string;
    target: number;
    behind: { daysLate: number | null; masteryAtExam: number } | null;
  },
): string {
  const target = Math.round(exam.target * 100);
  const atExam = Math.round((exam.behind?.masteryAtExam ?? 0) * 100);
  if (exam.behind?.daysLate == null)
    return t("planner.behindNoTime", { title: exam.title, target });
  return t("planner.behind", {
    title: exam.title,
    target,
    count: exam.behind.daysLate,
    atExam,
  });
}
