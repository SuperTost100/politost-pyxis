import type Database from "better-sqlite3";
import { readSessions } from "../plans/sessions";

export type CalendarLanguage = "en" | "it";

/** A session without a time is an all-day event. One with a time lasts this long, as nothing records an end. */
export const SESSION_MINUTES = 120;

export type CalendarExam = {
  planId: string;
  /** The session's ID, part of the event UID so moving a session moves its event. A plan's only session may omit it. */
  sessionId?: string;
  title: string;
  subject: string | null;
  /** "Written", "Oral": what tells two sessions of one plan apart. */
  label?: string | null;
  /** Local noon of the exam day in milliseconds, or null for "No date yet". */
  examAt: number | null;
  /** Local start time, "09:30", or null for an all-day event. */
  time?: string | null;
  place?: string | null;
};

const words = {
  en: {
    exam: "Exam",
    description: "Exam date from PoliTost Pyxis.",
    place: "Place",
    subject: "Subject",
    fallback: "exam",
  },
  it: {
    exam: "Esame",
    description: "Data dell’esame da PoliTost Pyxis.",
    place: "Luogo",
    subject: "Materia",
    fallback: "esame",
  },
} as const;

/** TEXT values: RFC 5545 section 3.3.11. */
export function escapeText(text: string): string {
  return text
    .replace(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
      "\ufffd",
    )
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/[\\;,]/g, (c) => `\\${c}`)
    .replaceAll("\n", "\\n");
}

/** Folds at 75 octets (RFC 5545 section 3.1) without splitting a character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let size = 0;
  // A continuation line spends one octet on its leading space.
  let limit = 75;
  for (const char of line) {
    const octets = Buffer.byteLength(char, "utf8");
    if (size + octets > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += octets;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const two = (n: number) => String(n).padStart(2, "0");
const dateValue = (year: number, month: number, day: number) =>
  `${year}${two(month)}${two(day)}`;

function localDay(time: number): { year: number; month: number; day: number } {
  const date = new Date(time);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function stamp(time: number): string {
  const d = new Date(time);
  return (
    dateValue(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) +
    `T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`
  );
}

/** "20261120T093000": a local time with no zone, so the event stays at 9:30 wherever the calendar is opened. */
function localStamp(year: number, month: number, day: number, minutes: number): string {
  // UTC arithmetic: the wall clock only moves by the minutes asked for, a clock change cannot skip or repeat them.
  const d = new Date(Date.UTC(year, month - 1, day, 0, minutes));
  return (
    dateValue(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) +
    `T${two(d.getUTCHours())}${two(d.getUTCMinutes())}00`
  );
}

/**
 * One event per exam session that falls today or later: all-day when the session has no time, otherwise a timed event
 * of SESSION_MINUTES with the place as its location. Days are local calendar days, so a noon timestamp keeps its day in
 * any time zone. Returns an empty string when there is nothing to export.
 */
export function buildCalendar(
  exams: CalendarExam[],
  language: CalendarLanguage,
  now = Date.now(),
): { ics: string; count: number } {
  const w = words[language];
  const today = new Date(now).setHours(0, 0, 0, 0);
  const upcoming = exams
    .filter(
      (e): e is CalendarExam & { examAt: number } =>
        e.examAt != null && new Date(e.examAt).setHours(0, 0, 0, 0) >= today,
    )
    .sort(
      (a, b) =>
        a.examAt - b.examAt ||
        (a.time ?? "").localeCompare(b.time ?? "") ||
        a.planId.localeCompare(b.planId) ||
        (a.sessionId ?? "").localeCompare(b.sessionId ?? ""),
    );
  if (upcoming.length === 0) return { ics: "", count: 0 };
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//PoliTost//Pyxis//${language.toUpperCase()}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const e of upcoming) {
    const { year, month, day } = localDay(e.examAt);
    // UTC arithmetic: the day after is never skipped or repeated by a clock change.
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const summary = escapeText(
      e.label ? `${w.exam}: ${e.title} (${e.label})` : `${w.exam}: ${e.title}`,
    );
    const place = e.place?.trim();
    const description = escapeText(
      [
        w.description,
        ...(e.subject ? [`${w.subject}: ${e.subject}`] : []),
        ...(place ? [`${w.place}: ${place}`] : []),
      ].join("\n"),
    );
    const clock = e.time?.match(/^(\d\d):(\d\d)$/);
    const start = clock ? Number(clock[1]) * 60 + Number(clock[2]) : null;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.sessionId ?? e.planId}@pyxis.politost.it`,
      `DTSTAMP:${stamp(now)}`,
      ...(start == null
        ? [
            `DTSTART;VALUE=DATE:${dateValue(year, month, day)}`,
            `DTEND;VALUE=DATE:${dateValue(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())}`,
          ]
        : [
            `DTSTART:${localStamp(year, month, day, start)}`,
            `DTEND:${localStamp(year, month, day, start + SESSION_MINUTES)}`,
          ]),
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      ...(place ? [`LOCATION:${escapeText(place)}`] : []),
      // 9:00 the day before: 15 hours before midnight, plus the time of day the event starts.
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${summary}`,
      `TRIGGER:-PT${reminderBefore(start)}`,
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return {
    ics: lines.map(foldLine).join("\r\n") + "\r\n",
    count: upcoming.length,
  };
}

/** The ISO duration from 9:00 the day before to the start: 15 h for an all-day event, more for a timed one. */
function reminderBefore(start: number | null): string {
  const minutes = 15 * 60 + (start ?? 0);
  const m = minutes % 60;
  return `${Math.floor(minutes / 60)}H${m ? `${m}M` : ""}`;
}

function fileName(title: string, fallback: string): string {
  const safe = [
    ...title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, 60)
    .join("")
    .trim();
  return `${safe || fallback}.ics`;
}

/** One plan's exam sessions as an .ics file named after the plan. */
export function exportCalendar(
  db: Database.Database,
  input: { planId: string; language: CalendarLanguage },
  now = Date.now(),
): { filename: string; base64: string; count: number } {
  const row = db
    .prepare(
      `SELECT p.id AS planId, p.title, s.name AS subject
       FROM plans p LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE p.id = ?`,
    )
    .get(input.planId) as
    | { planId: string; title: string; subject: string | null }
    | undefined;
  if (!row) throw new Error("plan-missing");
  const sessions = readSessions(db, input.planId);
  const exams: CalendarExam[] = sessions.map((session) => ({
    ...row,
    sessionId: session.id,
    label: session.label,
    examAt: session.date,
    time: session.time,
    place: session.place,
  }));
  const { ics, count } = buildCalendar(exams, input.language, now);
  return {
    filename: fileName(row.title, words[input.language].fallback),
    base64: Buffer.from(ics, "utf8").toString("base64"),
    count,
  };
}
