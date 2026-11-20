type Step = { activity: string; topicId: string | null };

/** The mastery from which the path suggests a quiz on a read topic instead of its exercises (`middle` in core/plans/path.ts). */
const QUIZ_FROM = 0.5;

/** What follows a topic's lesson, after the lesson: its exercises, then its quiz. */
const AFTER_LESSON = ["practice", "quiz"] as const;

/**
 * The step the end of a lesson offers next. The plan's suggestion stands, except when it is the introduction or the
 * diagnostic: those come before every lesson, so offering them after one reads wrong (the student skipped them, and
 * the lesson is what they chose). Then the next step is the topic's own: the quiz when its mastery reaches the line where
 * the path itself suggests one, else its exercises, skipping a step of this topic already done. Null when none is left.
 */
export function lessonNext<T extends Step>(input: {
  next: T | null;
  topicId: string;
  mastery: number | null;
  done: readonly Step[];
}): T | Step | null {
  const { next } = input;
  if (!next || (next.activity !== "intro" && next.activity !== "diagnostic")) return next;
  const from = input.mastery !== null && input.mastery >= QUIZ_FROM ? 1 : 0;
  const step = AFTER_LESSON.slice(from).find(
    (activity) => !input.done.some((item) => item.activity === activity && item.topicId === input.topicId),
  );
  return step ? { activity: step, topicId: input.topicId } : null;
}
