import dayjs, { type Dayjs } from "dayjs";

/** The exam line on a plan: the days left, today, or past. Never "0 days". */
export function examDaysLabel(
  t: (key: string, params?: { count: number }) => string,
  days: number,
): string {
  if (days < 0) return t("exams.pastExam");
  if (days === 0) return t("exams.today");
  return t("exams.days", { count: days });
}

/** The exam line for any plan: the month when that is all the student knows, else the days left. */
export function examLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  exam: { examAt: number; examMonth: boolean; days: number },
  language: string,
): string {
  if (!exam.examMonth || exam.days < 0) return examDaysLabel(t, exam.days);
  return t("exams.month", { month: monthName(exam.examAt, language) });
}

/** Days until the exam. A month-only exam counts to the 1st, then stays at 0 until the month ends, as in core. */
export function daysToExam(examAt: number, examMonth: boolean, now: Dayjs = dayjs()): number {
  const days = dayjs(examAt).startOf("day").diff(now.startOf("day"), "day");
  return examMonth && days < 0 && dayjs(examAt).isSame(now, "month") ? 0 : days;
}

/** "January 2027", "gennaio 2027". */
export function monthName(at: number, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }).format(at);
}
