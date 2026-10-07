/** The kinds of the plan's path_nodes rows; "final" is only read from older plans. */
export const stages = [
  "intro",
  "diagnostic",
  "learn",
  "practice",
  "cards",
  "gaps",
  "simulation",
  "final",
] as const;

export type Stage = (typeof stages)[number];

/** What a student can do on the path. Every activity is open at any time; the order is only a suggestion. */
export const activities = [
  "intro",
  "diagnostic",
  "lesson",
  "practice",
  "quiz",
  "cards",
  "gaps",
  "simulation",
] as const;

export type Activity = (typeof activities)[number];

/** Activities that need a topic; the others cover the whole plan. */
export const topicActivities: ReadonlySet<Activity> = new Set([
  "lesson",
  "practice",
  "quiz",
  "cards",
  "gaps",
]);

/** The path node an activity marks done in older plans; a quiz never had one. */
export function stageOf(activity: Activity): Stage | null {
  if (activity === "lesson") return "learn";
  if (activity === "quiz") return null;
  return activity;
}

/** The activity an older done node stands for; the final check was a goal, not an activity. */
export function activityOf(stage: string): Activity | null {
  if (stage === "learn") return "lesson";
  return (activities as readonly string[]).includes(stage) && stage !== "quiz"
    ? (stage as Activity)
    : null;
}

export type StepResult = { correct: number; total: number };

/** One finished activity, in the order the student did them. */
export type Step = {
  id: string;
  activity: Activity;
  topicId: string | null;
  at: number;
  result: StepResult | null;
};

export type SuggestReason =
  | "intro"
  | "diagnostic"
  | "due"
  | "gaps"
  | "examSoon"
  | "ready"
  | "consolidate"
  | "next"
  | "weakest";

export type Suggestion = {
  activity: Activity;
  topicId: string | null;
  reason: SuggestReason;
  count: number;
};

export type TopicStatus = {
  id: string;
  mastery: number;
  dueCards: number;
  severeGaps: number;
  daysIdle: number;
};

const middle = 0.5;
/** Within this many days of the exam a simulation is worth suggesting whatever the mastery. */
const examSoonDays = 3;

const weights = {
  due: 3,
  gap: 4,
  deficit: 2,
  idle: 1,
  style: 1,
};

/** The work that fits one topic now: due cards, then severe gaps, then the lesson, then exercises by mastery. */
export function topicSuggestion(topic: TopicStatus, read: boolean): Activity {
  if (topic.dueCards > 0) return "cards";
  if (topic.severeGaps > 0) return "gaps";
  if (!read) return "lesson";
  return topic.mastery < middle ? "practice" : "quiz";
}

/**
 * The suggested next step. Nothing is locked: this only picks what to offer first.
 * Due cards and severe gaps come first; a new plan then starts with the introduction and the diagnostic; a simulation
 * once every topic reaches the target or the exam is close, exercises on a lesson just read, the next unread topic in
 * the plan's order, and finally exercises on the weakest topic.
 */
export function suggestStep(input: {
  topics: TopicStatus[];
  steps: Array<Pick<Step, "activity" | "topicId">>;
  hasIntro: boolean;
  target: number;
  daysToExam: number | null;
}): Suggestion | null {
  const { topics, steps, target } = input;
  const done = (activity: Activity) => steps.some((step) => step.activity === activity);
  const read = new Set(
    steps.filter((step) => step.activity === "lesson").map((step) => step.topicId),
  );
  const studied =
    steps.some((step) => step.activity !== "intro" && step.activity !== "diagnostic") ||
    topics.some((topic) => topic.mastery > 0);
  const plan = (activity: Activity, reason: SuggestReason): Suggestion => ({
    activity,
    topicId: null,
    reason,
    count: 0,
  });
  const urgent = bestRecommendation(
    topics
      .filter((topic) => topic.dueCards > 0 || topic.severeGaps > 0)
      .map((topic) => ({
        id: topic.id,
        dueCards: topic.dueCards,
        severeGaps: topic.severeGaps,
        topicMastery: topic.mastery,
        target,
        daysToExam: input.daysToExam ?? 30,
        daysIdle: topic.daysIdle,
        styleMatch: 0,
      })),
  );
  if (urgent) {
    const topic = topics.find((item) => item.id === urgent.id)!;
    return topic.dueCards > 0
      ? { activity: "cards", topicId: topic.id, reason: "due", count: topic.dueCards }
      : { activity: "gaps", topicId: topic.id, reason: "gaps", count: topic.severeGaps };
  }
  if (!studied && !done("diagnostic")) {
    if (input.hasIntro && !done("intro")) return plan("intro", "intro");
    if (topics.length) return plan("diagnostic", "diagnostic");
  }
  if (!topics.length) return null;
  const weakest = Math.min(...topics.map((topic) => topic.mastery));
  if (weakest >= target) return plan("simulation", "ready");
  if (
    studied &&
    input.daysToExam != null &&
    input.daysToExam >= 0 &&
    input.daysToExam <= examSoonDays
  )
    return plan("simulation", "examSoon");
  const exercise = (topic: TopicStatus, reason: SuggestReason): Suggestion => ({
    activity: topic.mastery < middle ? "practice" : "quiz",
    topicId: topic.id,
    reason,
    count: 0,
  });
  const last = steps.at(-1);
  const justRead = last?.activity === "lesson" && topics.find((topic) => topic.id === last.topicId);
  if (justRead && justRead.mastery < target) return exercise(justRead, "consolidate");
  const unread = topics.find((topic) => !read.has(topic.id));
  if (unread) return { activity: "lesson", topicId: unread.id, reason: "next", count: 0 };
  const weak = topics.reduce((low, topic) => (topic.mastery < low.mastery ? topic : low));
  return exercise(weak, "weakest");
}

export function recommend(input: {
  dueCards: number;
  severeGaps: number;
  topicMastery: number;
  target: number;
  daysToExam: number;
  daysIdle: number;
  styleMatch: number;
}): { score: number; reason: string } {
  const urgency = 1 + 2 / Math.max(input.daysToExam, 1);
  const deficit = Math.max(0, input.target - input.topicMastery);
  const score =
    weights.due * input.dueCards +
    weights.gap * input.severeGaps +
    weights.deficit * deficit * urgency +
    weights.idle * input.daysIdle +
    weights.style * input.styleMatch;
  const reason =
    input.dueCards > 0
      ? `${input.dueCards} cards due`
      : input.severeGaps > 0
        ? `${input.severeGaps} severe gaps`
        : "next lesson";
  return { score, reason };
}

export function bestRecommendation(
  candidates: Array<Parameters<typeof recommend>[0] & { id: string }>,
): { id: string; reason: string } | null {
  let best: { id: string; score: number; reason: string } | null = null;
  for (const candidate of candidates) {
    const scored = recommend(candidate);
    if (!best || scored.score > best.score) {
      best = { id: candidate.id, score: scored.score, reason: scored.reason };
    }
  }
  return best ? { id: best.id, reason: best.reason } : null;
}
