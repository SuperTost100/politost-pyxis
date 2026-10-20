import type { MenuLanguage } from "./menu";

/** What a study reminder says: cards due now, and the plan the student should open (the one with the nearest exam). */
export type ReminderSummary = {
  dueCards: number;
  planId: string;
  planTitle: string;
  /** Whole days to the plan's exam; null without a date or once it has passed. */
  daysToExam: number | null;
};

/** The exam is mentioned from this many days out; a date months away only adds noise to a daily message. */
export const EXAM_MENTION_DAYS = 30;

export const DEFAULT_REMINDER_TIME = "18:00";

/** "HH:MM", 24-hour, local. */
export function isReminderTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const MAX_TITLE = 60;

/** The notification, in the interface language: "12 flashcard da ripassare, esame di Analisi tra 3 giorni". */
export function reminderText(
  language: MenuLanguage,
  summary: ReminderSummary,
): { title: string; body: string } {
  const plan =
    summary.planTitle.length > MAX_TITLE
      ? `${summary.planTitle.slice(0, MAX_TITLE - 1).trimEnd()}…`
      : summary.planTitle;
  const days = summary.daysToExam;
  const exam =
    days !== null && days >= 0 && days <= EXAM_MENTION_DAYS ? days : null;
  if (language === "it") {
    const cards = `${summary.dueCards} flashcard da ripassare`;
    const when =
      exam === null
        ? ""
        : exam === 0
          ? "oggi"
          : exam === 1
            ? "domani"
            : `tra ${exam} giorni`;
    return {
      title: "Ripasso di oggi",
      body: exam === null ? cards : `${cards}, esame di ${plan} ${when}`,
    };
  }
  const cards = `${summary.dueCards} ${summary.dueCards === 1 ? "flashcard" : "flashcards"} to review`;
  const when =
    exam === null
      ? ""
      : exam === 0
        ? "today"
        : exam === 1
          ? "tomorrow"
          : `in ${exam} days`;
  return {
    title: "Today's review",
    body: exam === null ? cards : `${cards}, ${plan} exam ${when}`,
  };
}

/**
 * Pages main may ask the renderer to open: a plan's page, or the Flashcards page. The preload checks it, so a message
 * from anywhere else cannot send the router to an arbitrary path.
 */
export function isOpenablePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "/exams/cards" || /^\/plans\/[A-Za-z0-9_-]{1,64}$/.test(value))
  );
}
