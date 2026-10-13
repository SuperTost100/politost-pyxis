/** The exam line on a plan: the days left, today, or past. Never "0 days". */
export function examDaysLabel(
  t: (key: string, params?: { count: number }) => string,
  days: number,
): string {
  if (days < 0) return t("exams.pastExam");
  if (days === 0) return t("exams.today");
  return t("exams.days", { count: days });
}
