import dayjs from "dayjs";
import {
  MAX_EXAM_SESSIONS,
  type ExamSession,
  type ExamSessionInput,
} from "../../../../shared/exam-sessions";

/** One session as the forms edit it: strings only, so an empty field is "". `date` is "YYYY-MM-DD". */
export type SessionDraft = {
  /** Identifies the row while editing. */
  key: string;
  /** The saved session this row edits, so its calendar event keeps its UID. */
  id?: string;
  date: string;
  /** "HH:mm" */
  time: string;
  place: string;
  label: string;
};

export { MAX_EXAM_SESSIONS };

let counter = 0;

export function emptyDraft(over: Partial<SessionDraft> = {}): SessionDraft {
  counter += 1;
  return { key: `session-${counter}`, date: "", time: "", place: "", label: "", ...over };
}

export function draftsFromSessions(sessions: ExamSession[]): SessionDraft[] {
  return sessions.map((session) =>
    emptyDraft({
      id: session.id,
      date: dayjs(session.date).format("YYYY-MM-DD"),
      time: session.time ?? "",
      place: session.place ?? "",
      label: session.label ?? "",
    }),
  );
}

/** Noon on the day, as `exam_at` always stored it, so a shared plan keeps its day in another time zone. */
export function noonOf(date: string): number {
  return new Date(`${date}T12:00:00`).getTime();
}

/** The sessions to save. A row without a date is not a session; that is how a plan gets "No date yet". */
export function sessionsFromDrafts(drafts: SessionDraft[]): ExamSessionInput[] {
  return drafts
    .filter((draft) => draft.date)
    .map((draft) => ({
      ...(draft.id ? { id: draft.id } : {}),
      date: noonOf(draft.date),
      time: draft.time || null,
      place: draft.place.trim() || null,
      label: draft.label.trim() || null,
    }));
}

/** Whether two edited lists would save the same sessions, ignoring row keys and empty rows. */
export function sameSessions(a: SessionDraft[], b: SessionDraft[]): boolean {
  return JSON.stringify(sessionsFromDrafts(a)) === JSON.stringify(sessionsFromDrafts(b));
}

/** The earliest session date that is today or later, as "YYYY-MM-DD", or null. */
export function nextUpcomingDay(drafts: SessionDraft[], today = dayjs().format("YYYY-MM-DD")): string | null {
  const days = drafts.map((draft) => draft.date).filter((date) => date && date >= today);
  return days.length ? days.sort()[0]! : null;
}
