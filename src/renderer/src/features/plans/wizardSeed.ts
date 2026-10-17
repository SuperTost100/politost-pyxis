import { examInstant } from "../../../../shared/plan-file";
import type { ExamSessionInput } from "../../../../shared/exam-sessions";
import { sessionsFromDrafts, type SessionDraft } from "./examSessions";

/** A quick exam choice in days, "none" for no date yet, or "" when the student picked a day or nothing yet. */
export type ExamChoice = "" | "none" | "1" | "2" | "3" | "10";

/** What the wizard has collected when the student chooses "no material". */
export type WizardSeed = {
  title: string;
  subject: string;
  examChoice: ExamChoice;
  /** The exam sessions as edited, with a blank row when none has a date. */
  sessions: SessionDraft[];
  target: number;
  language: "it" | "en";
};

export function isWizardSeed(value: unknown): value is WizardSeed {
  const seed = value as Partial<WizardSeed> | null;
  return (
    !!seed &&
    typeof seed.title === "string" &&
    typeof seed.subject === "string" &&
    ["", "none", "1", "2", "3", "10"].includes(seed.examChoice ?? "-") &&
    Array.isArray(seed.sessions) &&
    typeof seed.target === "number" &&
    (seed.language === "it" || seed.language === "en")
  );
}

/** Whether the exam step has an answer: a day, a quick choice, or "no date yet". */
export function examChosen(examChoice: ExamChoice, sessions: SessionDraft[]): boolean {
  return Boolean(examChoice || sessions.some((session) => session.date));
}

/** Noon on the chosen day, so a shared plan keeps its day in another time zone. Null for no date. */
export function examFromChoice(examChoice: ExamChoice, date: string, now = new Date()): number | null {
  const at = date
    ? new Date(`${date}T12:00:00`).getTime()
    : examChoice && examChoice !== "none"
      ? examInstant(Number(examChoice), now)
      : NaN;
  return Number.isFinite(at) ? at : null;
}

export function seedSessions(seed: WizardSeed): ExamSessionInput[] {
  return sessionsFromDrafts(seed.sessions);
}
