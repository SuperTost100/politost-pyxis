export type ReopenStep = {
  activity: string;
  topicId: string | null;
  itemId?: string | null;
  attemptId?: string | null;
};

/**
 * Where a finished step opens to look at it again, or null when there is nowhere to go. Nothing is recorded by
 * opening it: a lesson or the introduction to reread (the lesson as it was read, by its item), a quiz, drill,
 * diagnostic or simulation read-only with its answers (Redo starts a new one), exercises without "Mark as done", cards
 * without generating more or recording a step unless one is rated. A step without its attempt opens the topic's
 * lesson, or the activity's own page.
 */
export function reopenPath(planId: string, step: ReopenStep): string | null {
  const base = `/plans/${planId}`;
  const topic = step.topicId;
  const attempt = step.attemptId ? `?attempt=${encodeURIComponent(step.attemptId)}` : "";
  if (step.activity === "intro") return `${base}/intro`;
  if (step.activity === "diagnostic") return `${base}/diagnostic${attempt}`;
  if (step.activity === "simulation")
    return step.attemptId ? `${base}/exam/${step.attemptId}` : `${base}/simulation`;
  if (!topic) return null;
  if (step.activity === "practice") return `${base}/practice/${topic}?review=1`;
  if (step.activity === "cards") return `${base}/cards/${topic}?review=1`;
  if ((step.activity === "quiz" || step.activity === "gaps") && attempt)
    return `${base}/quiz/${topic}${attempt}`;
  if (step.activity === "lesson" && step.itemId)
    return `${base}/lesson/${topic}?item=${encodeURIComponent(step.itemId)}`;
  return `${base}/lesson/${topic}`;
}
