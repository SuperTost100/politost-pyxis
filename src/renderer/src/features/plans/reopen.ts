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

/** Where a step to do opens: the plan-wide pages, a topic's page, or a gap drill from Progress. */
export function stepPath(planId: string, activity: string, topicId: string | null): string | null {
  const base = `/plans/${planId}`;
  if (activity === "intro") return `${base}/intro`;
  if (activity === "diagnostic" || activity === "simulation") return `${base}/${activity}`;
  if (!topicId) return null;
  if (activity === "gaps") return `${base}/progress?drill=${encodeURIComponent(topicId)}`;
  return `${base}/${activity}/${topicId}`;
}

/**
 * Where "Skip the test" goes: the lesson of the first topic not read yet. Core keeps no skip state; the path stops
 * suggesting the diagnostic once anything is studied, and then suggests this same lesson (rule 8 in docs/mastery.md).
 */
export function skipDiagnosticPath(
  planId: string,
  topics: ReadonlyArray<{ id: string }>,
  steps: ReadonlyArray<{ activity: string; topicId: string | null }>,
): string | null {
  const read = new Set(steps.filter((step) => step.activity === "lesson").map((step) => step.topicId));
  const first = topics.find((topic) => !read.has(topic.id));
  return first ? stepPath(planId, "lesson", first.id) : null;
}
