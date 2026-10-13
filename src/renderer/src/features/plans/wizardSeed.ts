import { examInstant } from "../../../../shared/plan-file";

/** What the wizard has collected when the student chooses "no material". */
export type WizardSeed = {
  title: string;
  subject: string;
  /** A quick choice in days, or "" when the student picked a date or a month instead. */
  examChoice: "" | "1" | "2" | "3" | "10";
  /** "YYYY-MM-DD" for a day, "YYYY-MM" when only the month is known, "" for a quick choice. */
  date: string;
  target: number;
  language: "it" | "en";
};

export function isWizardSeed(value: unknown): value is WizardSeed {
  const seed = value as Partial<WizardSeed> | null;
  return (
    !!seed &&
    typeof seed.title === "string" &&
    typeof seed.subject === "string" &&
    ["", "1", "2", "3", "10"].includes(seed.examChoice ?? "-") &&
    typeof seed.date === "string" &&
    typeof seed.target === "number" &&
    (seed.language === "it" || seed.language === "en")
  );
}

/**
 * The exam as stored: noon on the chosen day, or noon on the 1st when only the month is known, so a shared plan keeps
 * its day in another time zone. Null when nothing was chosen.
 */
export function examFromChoice(
  examChoice: WizardSeed["examChoice"],
  date: string,
  now = new Date(),
): { examAt: number | null; examMonth: boolean } {
  const examMonth = /^\d{4}-\d{2}$/.test(date);
  const at = date
    ? new Date(`${examMonth ? `${date}-01` : date}T12:00:00`).getTime()
    : examChoice
      ? examInstant(Number(examChoice), now)
      : NaN;
  return Number.isFinite(at)
    ? { examAt: at, examMonth }
    : { examAt: null, examMonth: false };
}

export function seedExamAt(seed: WizardSeed) {
  return examFromChoice(seed.examChoice, seed.date);
}
