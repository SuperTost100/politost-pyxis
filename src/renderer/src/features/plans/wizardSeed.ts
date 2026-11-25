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
  /** The goal as stored, a fraction from 0.5 to 1. */
  target: number;
  language: "it" | "en";
  /** Library sources already chosen as material, such as the ones a chat's proposal of this exam named. */
  picked?: string[];
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
    (seed.language === "it" || seed.language === "en") &&
    (seed.picked === undefined || (Array.isArray(seed.picked) && seed.picked.every((id) => typeof id === "string")))
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

/** The statuses a source cannot be built from, as the exam form refuses them, and a source the student removed. */
const UNUSABLE = new Set(["failed", "needs-ocr", "cancelled", "interrupted", "removed"]);

/**
 * The seeded sources the Library still has, usable, and how many of them it no longer does: a proposal from the chat can
 * name a source that was removed or failed since, which the exam must not be created with.
 */
export function availableSeed(
  picked: readonly string[],
  library: ReadonlyArray<{ id: string; status: string }>,
): { kept: string[]; dropped: number } {
  const kept = picked.filter((id) => library.some((source) => source.id === id && !UNUSABLE.has(source.status)));
  return { kept, dropped: picked.length - kept.length };
}
