/** The activities a topic row shows as its steps, in the order a student does them. */
export const topicSteps = ["lesson", "practice", "quiz", "cards", "gaps"] as const;
export type TopicStep = (typeof topicSteps)[number];

/** done: finished; missed: the latest quiz is below the goal; todo: not done yet; now: the path's next step. */
export type StepState = "done" | "missed" | "todo" | "now";

export type StepChip = {
  activity: TopicStep;
  state: StepState;
  /** The latest quiz's score. */
  result?: { correct: number; total: number };
  /** Due flashcards, or open gaps. */
  count?: number;
};

export type TopicRow = {
  id: string;
  title: string;
  /** 1-based place in the path. */
  index: number;
  mastery: number;
  atGoal: boolean;
  gaps: number;
  /** The topic the path's next step is on. */
  current: boolean;
  /** Steps finished on this topic. */
  done: number;
  /** The latest finished step on this topic. */
  last: { activity: string; at: number } | null;
  /** The day the planner expects the topic at the goal (YYYY-MM-DD); null when it does not fit before the exam;
   * undefined when there is no date to give (no planner hours, no exam date, or the topic is at the goal). */
  date: string | null | undefined;
  steps: StepChip[];
};

type Step = {
  activity: string;
  topicId: string | null;
  at: number;
  result: { correct: number; total: number } | null;
};

/**
 * The path's topic rows: each topic in the plan's order with its mastery against the goal, its open gaps, the day the
 * planner expects it done, and its steps. Lesson, exercises and quiz always show; flashcards only when some are due and
 * the gap drill only when a gap is open. The path's next step, when it is on this topic, is marked `now`.
 */
export function topicRows(input: {
  topics: ReadonlyArray<{ id: string; title: string }>;
  steps: ReadonlyArray<Step>;
  status: ReadonlyArray<{ topicId: string; mastery: number; dueCards: number; gaps: number }>;
  next: { activity: string; topicId: string | null } | null;
  goal: number;
  schedule: ReadonlyArray<{ topicId: string; date: string | null }> | null;
}): TopicRow[] {
  const status = new Map(input.status.map((row) => [row.topicId, row]));
  const dates = new Map(input.schedule?.map((row) => [row.topicId, row.date]));
  return input.topics.map((topic, position) => {
    const own = input.steps.filter((step) => step.topicId === topic.id);
    const did = (activity: string) => own.some((step) => step.activity === activity);
    const quiz = own.filter((step) => step.activity === "quiz" && step.result).at(-1)?.result;
    const mastery = status.get(topic.id)?.mastery ?? 0;
    const dueCards = status.get(topic.id)?.dueCards ?? 0;
    const gaps = status.get(topic.id)?.gaps ?? 0;
    const current = input.next?.topicId === topic.id;
    const chips: StepChip[] = [
      { activity: "lesson", state: did("lesson") ? "done" : "todo" },
      { activity: "practice", state: did("practice") ? "done" : "todo" },
      quiz
        ? {
            activity: "quiz",
            state: quiz.total > 0 && quiz.correct / quiz.total >= input.goal ? "done" : "missed",
            result: quiz,
          }
        : { activity: "quiz", state: "todo" },
    ];
    if (dueCards > 0) chips.push({ activity: "cards", state: "todo", count: dueCards });
    if (gaps > 0) chips.push({ activity: "gaps", state: "todo", count: gaps });
    const last = own.at(-1);
    return {
      id: topic.id,
      title: topic.title,
      index: position + 1,
      mastery,
      atGoal: mastery >= input.goal,
      gaps,
      current,
      done: own.length,
      last: last ? { activity: last.activity, at: last.at } : null,
      date: dates.has(topic.id) ? dates.get(topic.id) : undefined,
      steps: chips.map((chip) =>
        current && chip.activity === input.next?.activity ? { ...chip, state: "now" } : chip,
      ),
    };
  });
}
