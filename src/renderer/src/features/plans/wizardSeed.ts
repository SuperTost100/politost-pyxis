import { examInstant } from "@shared/plan-file";

/** What the wizard has collected when the student chooses "no material". */
export type WizardSeed = {
  title: string;
  subject: string;
  examChoice: "1" | "2" | "3" | "10";
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
    ["1", "2", "3", "10"].includes(seed.examChoice ?? "") &&
    typeof seed.date === "string" &&
    typeof seed.target === "number" &&
    (seed.language === "it" || seed.language === "en")
  );
}

export function seedExamAt(seed: WizardSeed): number | null {
  const at = seed.date
    ? new Date(`${seed.date}T12:00:00`).getTime()
    : examInstant(Number(seed.examChoice));
  return Number.isFinite(at) ? at : null;
}
