import type Database from "better-sqlite3";

export type CalendarLanguage = "en" | "it";

export type CalendarExam = {
  planId: string;
  title: string;
  subject: string | null;
  /** Local noon of the exam day in milliseconds, or null for "No date yet". */
  examAt: number | null;
};

const words = {
  en: {
    exam: "Exam",
    description: "Exam date from PoliTost Pyxis.",
    subject: "Subject",
    fallback: "exam",
  },
  it: {
    exam: "Esame",
    description: "Data dell’esame da PoliTost Pyxis.",
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

/**
 * One all-day event per exam that has a date today or later. Days are local
 * calendar days, so a noon timestamp keeps its day in any time zone. Returns
 * an empty string when there is nothing to export.
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
    .sort((a, b) => a.examAt - b.examAt || a.planId.localeCompare(b.planId));
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
    const summary = escapeText(`${w.exam}: ${e.title}`);
    const description = escapeText(
      e.subject
        ? `${w.description}\n${w.subject}: ${e.subject}`
        : w.description,
    );
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.planId}@pyxis.politost.it`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${dateValue(year, month, day)}`,
      `DTEND;VALUE=DATE:${dateValue(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())}`,
      `SUMMARY:${summary}`,
      `DESCRIPTION:${description}`,
      // An all-day event starts at 0:00, so 15 hours earlier is 9:00 the day before.
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${summary}`,
      "TRIGGER:-PT15H",
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

/** One plan's exam as an .ics file named after the plan. */
export function exportCalendar(
  db: Database.Database,
  input: { planId: string; language: CalendarLanguage },
  now = Date.now(),
): { filename: string; base64: string; count: number } {
  const row = db
    .prepare(
      `SELECT p.id AS planId, p.title, s.name AS subject, p.exam_at AS examAt
       FROM plans p LEFT JOIN subjects s ON s.id = p.subject_id
       WHERE p.id = ?`,
    )
    .get(input.planId) as CalendarExam | undefined;
  if (!row) throw new Error("plan-missing");
  const { ics, count } = buildCalendar([row], input.language, now);
  return {
    filename: fileName(row.title, words[input.language].fallback),
    base64: Buffer.from(ics, "utf8").toString("base64"),
    count,
  };
}
