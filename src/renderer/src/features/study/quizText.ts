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
 * The line under a finished quiz's score. Under half, a diagnostic has done its job by showing where to start; any other
 * quiz points at what to review instead.
 */
export function verdictLine(percent: number, diagnostic: boolean): string {
  if (percent >= 90) return "quiz.verdictGreat";
  if (percent >= 70) return "quiz.verdictGood";
  if (percent >= 50) return "quiz.verdictClose";
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
