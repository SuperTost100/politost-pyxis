import { z } from "zod";

/** The most sessions one plan holds: a written part, an oral part, a retake or two. */
export const MAX_EXAM_SESSIONS = 10;
export const SESSION_PLACE_MAX = 200;
export const SESSION_LABEL_MAX = 80;
/**
 * The latest session date: before 10:00 UTC on 30 December 9999 it is still that day or earlier in every time zone
 * (UTC-12 to UTC+14), so the day and the calendar's day after it keep four-digit years.
 */
export const SESSION_DATE_MAX = Date.UTC(9999, 11, 30, 10) - 1;

/** "09:30": 24-hour clock, minutes 00 to 59. */
const sessionTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * One sitting of an exam. `date` is local noon of the day in milliseconds, as `exam_at` always was, so a day keeps its
 * number in any time zone. `time` is the start on that day, local, and empty for an all-day entry.
 */
export const examSessionSchema = z.object({
  /** Present for a session that already exists; a new one gets an ID when saved. */
  id: z.string().min(1).max(160).optional(),
  date: z.number().int().min(0).max(SESSION_DATE_MAX),
  time: sessionTime.nullable().optional(),
  place: z.string().trim().max(SESSION_PLACE_MAX).nullable().optional(),
  label: z.string().trim().max(SESSION_LABEL_MAX).nullable().optional(),
});

export const examSessionsSchema = z.array(examSessionSchema).max(MAX_EXAM_SESSIONS);

export type ExamSessionInput = z.infer<typeof examSessionSchema>;

/** A session as core and the renderer read it back. */
export type ExamSession = {
  id: string;
  date: number;
  time: string | null;
  place: string | null;
  label: string | null;
};

/**
 * The date countdowns, scheduling and the path read: the earliest session that is today or later, or the latest one
 * when every session is over (so a finished exam still counts days since), or null for "No date yet".
 */
export function nextExamDate(dates: number[], now: number): number | null {
  if (dates.length === 0) return null;
  const today = new Date(now).setHours(0, 0, 0, 0);
  const upcoming = dates.filter((date) => date >= today);
  return upcoming.length > 0 ? Math.min(...upcoming) : Math.max(...dates);
}
