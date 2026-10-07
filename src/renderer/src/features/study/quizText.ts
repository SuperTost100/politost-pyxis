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
