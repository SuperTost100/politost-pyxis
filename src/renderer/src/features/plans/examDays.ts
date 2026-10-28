import { reachableTarget } from "../../../../shared/plan-file";

/**
 * The plan's on-track count with the mastery it counts against, each written by `format` on the profile's scale. A
 * full-mark target counts topics at 0.99 (a decayed weighted mean never returns to 1 after a miss), so that line names
 * both numbers.
 */
export function onTrackLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  ready: number,
  count: number,
  target: number,
  format: (fraction: number) => string,
): string {
  const goal = format(target);
  const threshold = format(reachableTarget(target));
  return threshold === goal
    ? t("progress.onTrack", { ready, count, target: goal })
    : t("progress.onTrackReachable", { ready, count, threshold, target: goal });
}

/** The exam line on a plan: the days left, today, or past. Never "0 days". */
export function examDaysLabel(
  t: (key: string, params?: { count: number }) => string,
  days: number,
): string {
  if (days < 0) return t("exams.pastExam");
  if (days === 0) return t("exams.today");
  return t("exams.days", { count: days });
}
