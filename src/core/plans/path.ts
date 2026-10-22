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
  /** The lesson or introduction that was read; null on other steps and on steps older than this field. */
  itemId: string | null;
  /** The submitted quiz, gap drill, diagnostic or simulation, so the step can reopen it for review. */
  attemptId: string | null;
};

export type SuggestReason =
  | "intro"
  | "diagnostic"
  | "due"
  | "gaps"
  | "examSoon"
  | "ready"
  | "consolidate"
  | "check"
  | "stay"
  | "review"
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
  /** Graded activities on the topic since its lesson was read (see `gradedActivities`); 0 while it is unread. */
  graded: number;
};

const middle = 0.5;
/** Within this many days of the exam a simulation is worth suggesting whatever the mastery. */
const examSoonDays = 3;
/** After a lesson the path stays on its topic until the topic reaches this mastery (or the target, if lower)... */
const stayMastery = 0.6;
/** ...or until the student has done this many graded activities on it, so a student who keeps missing moves on. */
export const stayActivities = 3;
/** A read topic below the target that nobody touched for this many days gets a review quiz before a new chapter. */
const reviewAfterDays = 7;

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
 * once every topic reaches the target or the exam is close. Then the path stays on the topic of the latest lesson,
 * alternating exercises and quizzes, until that topic reaches `stayMastery` or has `stayActivities` graded activities.
 * After that: a quiz on exercises just done, a review quiz on a topic left idle for `reviewAfterDays`, the next unread
 * topic in the plan's order, and finally exercises on the weakest topic.
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
  // The topic of the latest lesson keeps the path until it holds: one quiz of five answers cannot reach the target,
  // so three steps per topic left most topics below it. Exercises and quizzes alternate, starting with exercises.
  const lessonAt = steps.findLastIndex((step) => step.activity === "lesson");
  const current = lessonAt < 0 ? undefined : topics.find((topic) => topic.id === steps[lessonAt]!.topicId);
  if (
    current &&
    current.mastery < Math.min(stayMastery, target) &&
    current.graded < stayActivities
  ) {
    const since = steps.slice(lessonAt + 1).filter((step) => step.topicId === current.id);
    const lastWork = since.findLast(
      (step) => step.activity === "practice" || step.activity === "quiz" || step.activity === "gaps",
    );
    if (lastWork?.activity === "practice")
      return { activity: "quiz", topicId: current.id, reason: "check", count: 0 };
    return {
      activity: "practice",
      topicId: current.id,
      reason: since.length ? "stay" : "consolidate",
      count: 0,
    };
  }
  // Spaced review: what was read and then left alone fades, so it comes back before a new chapter. The longest idle
  // goes first; a topic never touched has nothing to review.
  const idle = topics
    .filter(
      (topic) =>
        read.has(topic.id) && topic.mastery < target && topic.daysIdle >= reviewAfterDays,
    )
    .reduce<TopicStatus | undefined>(
      (most, topic) =>
        !most ||
        topic.daysIdle > most.daysIdle ||
        (topic.daysIdle === most.daysIdle && topic.mastery < most.mastery)
          ? topic
          : most,
      undefined,
    );
  const unread = topics.find((topic) => !read.has(topic.id));
  // Exercises are not graded: a "Got it" or "Missed it" is only light evidence (weight 0.5), and many students rate
  // nothing, so practice moves mastery little or not at all. A quiz measures what they taught; without it the weakest
  // topic would get exercises again and again. The topic whose stay just ended moves on instead, when there is a
  // review or a new chapter to move on to.
  const last = steps.at(-1);
  const justPracticed =
    last?.activity === "practice" && topics.find((topic) => topic.id === last.topicId);
  if (
    justPracticed &&
    justPracticed.mastery < target &&
    !(justPracticed.id === current?.id && (idle || unread))
  )
    return { activity: "quiz", topicId: justPracticed.id, reason: "check", count: 0 };
  if (idle) return { activity: "quiz", topicId: idle.id, reason: "review", count: idle.daysIdle };
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
