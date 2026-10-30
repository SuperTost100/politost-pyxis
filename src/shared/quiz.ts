/** No quiz or diagnostic asks more than this many questions. */
export const QUIZ_MAX_QUESTIONS = 10;

/** Rough minutes a student needs for these questions: closed answers are quick, open ones take a few minutes. */
export function quizMinutes(kinds: string[]): number {
  const seconds = kinds.reduce(
    (sum, kind) =>
      sum + (kind === "open" ? 180 : kind === "mcq" || kind === "tf" ? 45 : 90),
    0,
  );
  return Math.max(1, Math.round(seconds / 60));
}

/** How an answer check job names the answer it corrects, for the quiz page waiting on it (`JobView.ref`). */
export function checkRef(attemptId: string, questionId: string): string {
  return `${attemptId}/${questionId}`;
}
