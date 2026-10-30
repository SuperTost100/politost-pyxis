export type Citation = { passageId: string; label: string };

/** One graded answer as the quiz screens show it. */
export type QuizAnswer = {
  id: string;
  score: number;
  expected: string;
  explanation: string;
  citations: Citation[];
  model?: string;
  flagged?: boolean;
};

export type QuizQuestion = {
  id: string;
  stem: string;
  topicId?: string;
  options?: string[];
  left?: string[];
  right?: string[];
  grade: { kind: string };
};

export function blanks(raw: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}

export function pairs(raw: string | undefined): Array<[string, string]> {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (item): item is [string, string] =>
            Array.isArray(item) &&
            typeof item[0] === "string" &&
            typeof item[1] === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** A completion stem shows its `{{1}}` gaps as a blank line. */
export function stemText(stem: string): string {
  return stem.replace(/\{\{\d+\}\}/g, "\\_\\_\\_\\_\\_");
}

export function verdict(score: number): "correct" | "partial" | "wrong" {
  return score >= 1 ? "correct" : score > 0 ? "partial" : "wrong";
}

/**
 * The line under a finished quiz's score, judged by the distance from the exam's goal (both as percentages): at the
 * goal, within ten points of it, over 60% of it. Under that, a diagnostic has done its job by showing where to start;
 * any other quiz points at what to review instead. `goal` is the default goal (75) when the exam has none.
 * Pass the percentages unrounded: 74,6% against a goal of 75% has not reached it.
 */
export function verdictLine(percent: number, diagnostic: boolean, goal = 75): string {
  // Callers pass the exact percentages. The tolerance only absorbs float noise from summed partial credit.
  const reaches = (mark: number) => percent >= mark - 1e-9;
  if (reaches(goal)) return "quiz.verdictGreat";
  if (reaches(goal - 10)) return "quiz.verdictClose";
  if (reaches(goal * 0.6)) return "quiz.verdictGood";
  return diagnostic ? "quiz.verdictStart" : "quiz.verdictLow";
}

/**
 * The order the student meets the questions in: skipped ones come back after all the others, in the order they were
 * skipped. A question is skipped at most once, so this is the last move any question makes.
 */
export function skipOrder<T extends { id: string }>(
  questions: T[],
  skipped: string[],
): T[] {
  const late = new Set(skipped);
  return [
    ...questions.filter((question) => !late.has(question.id)),
    ...skipped.flatMap((id) => questions.filter((question) => question.id === id)),
  ];
}

/**
 * The pick "Try again" sends after a failed check. The fields unlock on a failure, so an edited answer wins; an
 * untouched one resends what failed, which keeps an "I don't know" (an empty pick) as it was.
 */
export function retryPick(failed: string, pickAtFailure: string, current: string): string {
  return current === pickAtFailure ? failed : current;
}

/** Where closing a quiz goes: the Review page from a Review's questions, the notebook (narrowed as it was) from a redo, else the exam. */
export function quizBack(input: { planId: string | undefined; redo?: boolean; review?: boolean; notebookExam?: string | null }): string {
  if (input.redo) return `/exams/mistakes${input.notebookExam ? `?exam=${encodeURIComponent(input.notebookExam)}` : ""}`;
  return `/plans/${input.planId ?? ""}${input.review ? "/review" : ""}`;
}
