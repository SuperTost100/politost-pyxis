// Prior of 3 empty observations, so one fresh score cannot look like mastery.

export const MASTERY_PRIOR_COUNT = 3;
export const MASTERY_HALF_LIFE_DAYS = 14;
export const MASTERY_WEIGHTS = {
  quiz: 1,
  open: 1.5,
  simulation: 2,
  card: 0.5,
  /** A quick check inside a lesson: one guided question, so it weighs half a quiz answer. */
  check: 0.5,
  /** "Got it" or "Missed it" after a practice exercise: the student's own word, so it weighs half a quiz answer. */
  self: 0.5,
} as const;

/** A new rating of the same exercise made less than this long after the last one replaces it (one visit, one rating). */
export const SELF_RATING_WINDOW_MS = 6 * 3_600_000;

export type MasteryEvent = {
  topicId: string;
  kind: "quiz" | "simulation" | "card" | "lesson" | "check" | "self";
  answerKind?: string;
  cardId?: string;
  /** The exercise a "self" rating is about; ratings without one never replace each other. */
  exerciseId?: string;
  /**
   * The lesson a quick check was answered in, the question, and whether the question is still in the lesson's current
   * text. Checks without one (their lesson is unknown) all count.
   */
  lessonCheck?: LessonCheck;
  score: number;
  at: number;
};

export type LessonCheck = { itemId: string; blockId: string; current: boolean };

const MS_PER_DAY = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = MASTERY_HALF_LIFE_DAYS;

/**
 * Quick checks count from one lesson per topic: the one, in any wording, answered most recently by `now`. Its answers
 * count once per question, the first one as the lesson shows it, and only for questions still in its current text, so
 * rewriting the lesson or reading it in another wording cannot add evidence. Returns the checks that count.
 */
export function currentChecks<T extends { topicId: string; at: number; lessonCheck?: LessonCheck }>(
  rows: T[],
  now: number,
): Set<T> {
  const answered = rows.filter((row) => row.lessonCheck && row.at <= now).sort((a, b) => a.at - b.at);
  const latest = new Map<string, string>();
  for (const row of answered) latest.set(row.topicId, row.lessonCheck!.itemId);
  const kept = new Set<T>();
  const seen = new Set<string>();
  for (const row of answered) {
    const check = row.lessonCheck!;
    if (!check.current || latest.get(row.topicId) !== check.itemId) continue;
    const key = `${check.itemId}\u0000${check.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.add(row);
  }
  return kept;
}

/** Drops each rating that a later rating of the same exercise replaced within the window. Keeps the order of the rest. */
export function currentRatings<T extends { at: number }>(
  rows: T[],
  keyOf: (row: T) => string | undefined,
): T[] {
  const keep = new Set<T>();
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) keep.add(row);
    else groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.at - b.at);
    group.forEach((row, index) => {
      const next = group[index + 1];
      if (!next || next.at - row.at >= SELF_RATING_WINDOW_MS) keep.add(row);
    });
  }
  return rows.filter((row) => keep.has(row));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function decayWeight(now: number, at: number, halfLifeDays: number): number {
  const ageMs = now - at;
  if (ageMs <= 0) return 1;
  return 0.5 ** (ageMs / (halfLifeDays * MS_PER_DAY));
}

/** The score of each topic with evidence. A topic without evidence is absent and counts as 0. */
export function masteryFor(
  events: MasteryEvent[],
  now: number,
  opts?: { halfLifeDays?: number },
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [topicId, detail] of Object.entries(
    masteryDetail(events, now, opts),
  ))
    out[topicId] = detail.mastery;
  return out;
}

/** The kinds of evidence a topic's mastery is made of. A lesson read counts for none. */
export type MasteryGroup = "quiz" | "simulation" | "check" | "self" | "card";
export const MASTERY_GROUPS: readonly MasteryGroup[] = [
  "quiz",
  "simulation",
  "check",
  "self",
  "card",
];

/** A lesson read never reaches the sums; the fallback only satisfies the type. */
function groupOf(event: MasteryEvent): MasteryGroup {
  return event.kind === "lesson" ? "quiz" : event.kind;
}

export type MasteryPart = {
  /** Observations that count: quiz answers, cards with a review, and so on. */
  count: number;
  /** Their weights added up after decay (cards do not decay). */
  weight: number;
  /** Their weighted scores added up. `points / (prior + all weights)` is what this part adds to the mastery. */
  points: number;
  /** The plain average score, without weights or decay; for cards, the average recall. */
  mean: number;
};

export type TopicMastery = {
  mastery: number;
  parts: Record<MasteryGroup, MasteryPart>;
  /** The empty observations added to every topic, so one lucky answer cannot look like mastery. */
  priorWeight: number;
  /** What age took off: the mastery minus the mastery the same evidence would give with no decay. */
  decay: number;
};

/**
 * The mastery of each topic with evidence, and the parts it is made of. `masteryFor` is this function's
 * `mastery` field, so the parts always add up to the number shown:
 * `mastery = sum(part.points) / (priorWeight + sum(part.weight))`, kept inside 0..1.
 */
export function masteryDetail(
  events: MasteryEvent[],
  now: number,
  opts?: { halfLifeDays?: number },
): Record<string, TopicMastery> {
  const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const byTopic = new Map<string, MasteryEvent[]>();

  const latestCards = new Map<string, MasteryEvent>();
  // A later rating replaces an earlier one only once it exists, so replaying an earlier date keeps the earlier rating.
  const ratings = new Set(
    currentRatings(
      events.filter((e) => e.kind === "self" && e.at <= now),
      (e) => (e.exerciseId ? `${e.topicId}\u0000${e.exerciseId}` : undefined),
    ),
  );
  // Like ratings, a later lesson replaces an earlier one's checks only from when it was answered.
  const checks = currentChecks(
    events.filter((e) => e.kind === "check"),
    now,
  );
  for (const e of events) {
    if (e.kind === "self" && !ratings.has(e)) continue;
    if (e.kind === "check" && e.lessonCheck && !checks.has(e)) continue;
    if (e.kind === "lesson" || e.at > now || !Number.isFinite(e.score))
      continue;
    if (e.kind === "card" && e.cardId) {
      const previous = latestCards.get(e.cardId);
      if (!previous || previous.at <= e.at) latestCards.set(e.cardId, e);
      continue;
    }
    const list = byTopic.get(e.topicId);
    if (list) list.push(e);
    else byTopic.set(e.topicId, [e]);
  }

  for (const e of latestCards.values()) {
    const list = byTopic.get(e.topicId) ?? [];
    list.push(e);
    byTopic.set(e.topicId, list);
  }

  const out: Record<string, TopicMastery> = {};

  for (const [topicId, topicEvents] of byTopic) {
    if (topicEvents.length === 0) continue;

    const parts = Object.fromEntries(
      MASTERY_GROUPS.map((group) => [
        group,
        { count: 0, weight: 0, points: 0, mean: 0 },
      ]),
    ) as Record<MasteryGroup, MasteryPart>;
    let weightedSum = 0;
    let totalWeight = 0;
    let steadySum = 0;
    let steadyWeight = 0;

    for (const e of topicEvents) {
      const typeWeight =
        e.kind === "card"
          ? MASTERY_WEIGHTS.card
          : e.kind === "check"
            ? MASTERY_WEIGHTS.check
            : e.kind === "self"
              ? MASTERY_WEIGHTS.self
              : e.kind === "simulation"
              ? MASTERY_WEIGHTS.simulation
            : e.answerKind === "open"
              ? MASTERY_WEIGHTS.open
              : MASTERY_WEIGHTS.quiz;
      const w =
        typeWeight *
        (e.kind === "card" ? 1 : decayWeight(now, e.at, halfLifeDays));
      if (w === 0) continue;
      const score = clamp01(e.score);
      const part = parts[groupOf(e)];
      part.count += 1;
      part.weight += w;
      part.points += score * w;
      part.mean += score;
      weightedSum += score * w;
      totalWeight += w;
      steadySum += score * typeWeight;
      steadyWeight += typeWeight;
    }

    if (totalWeight === 0) continue;

    for (const part of Object.values(parts))
      if (part.count) part.mean /= part.count;
    const mastery = clamp01(
      weightedSum / (MASTERY_PRIOR_COUNT + totalWeight),
    );
    out[topicId] = {
      mastery,
      parts,
      priorWeight: MASTERY_PRIOR_COUNT,
      decay:
        mastery -
        clamp01(steadySum / (MASTERY_PRIOR_COUNT + steadyWeight)),
    };
  }

  return out;
}

export function idleTopics(
  events: MasteryEvent[],
  now: number,
  idleDays = 7,
): string[] {
  const latestByTopic = new Map<string, number>();

  for (const e of events) {
    const prev = latestByTopic.get(e.topicId);
    if (prev === undefined || e.at > prev) latestByTopic.set(e.topicId, e.at);
  }

  const thresholdMs = idleDays * MS_PER_DAY;
  const idle: string[] = [];

  for (const [topicId, latestAt] of latestByTopic) {
    if (now - latestAt > thresholdMs) idle.push(topicId);
  }

  idle.sort();
  return idle;
}
