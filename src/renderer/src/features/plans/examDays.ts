import { reachableTarget } from "../../../../shared/plan-file";

/**
 * The plan's on-track count with the mastery it counts against. A 100% target counts topics at 99% (a decayed weighted
 * mean never returns to 1 after a miss), so that line names both numbers.
 */
export function onTrackLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  ready: number,
  count: number,
  target: number,
): string {
  const percent = Math.round(target * 100);
  const threshold = Math.round(reachableTarget(target) * 100);
  return threshold === percent
    ? t("progress.onTrack", { ready, count, target: percent })
    : t("progress.onTrackReachable", { ready, count, threshold, target: percent });
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
