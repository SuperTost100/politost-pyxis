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
  score: number;
  at: number;
};

const MS_PER_DAY = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = MASTERY_HALF_LIFE_DAYS;

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

export function masteryFor(
  events: MasteryEvent[],
  now: number,
  opts?: { halfLifeDays?: number },
): Record<string, number> {
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
  for (const e of events) {
    if (e.kind === "self" && !ratings.has(e)) continue;
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

  const out: Record<string, number> = {};

  for (const [topicId, topicEvents] of byTopic) {
    if (topicEvents.length === 0) continue;

    let weightedSum = 0;
    let totalWeight = 0;

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
      weightedSum += clamp01(e.score) * w;
      totalWeight += w;
    }

    if (totalWeight === 0) continue;

    out[topicId] = clamp01(weightedSum / (MASTERY_PRIOR_COUNT + totalWeight));
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
