// Prior of 3 empty observations, so one fresh score cannot look like mastery.

const PRIOR_COUNT = 3;

export type MasteryEvent = {
  topicId: string;
  kind: "quiz" | "card" | "lesson";
  score: number;
  at: number;
};

const MS_PER_DAY = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 14;

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

  for (const e of events) {
    const list = byTopic.get(e.topicId);
    if (list) list.push(e);
    else byTopic.set(e.topicId, [e]);
  }

  const out: Record<string, number> = {};

  for (const [topicId, topicEvents] of byTopic) {
    if (topicEvents.length === 0) continue;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const e of topicEvents) {
      const w = decayWeight(now, e.at, halfLifeDays);
      if (w === 0) continue;
      weightedSum += clamp01(e.score) * w;
      totalWeight += w;
    }

    if (totalWeight === 0) continue;

    out[topicId] = clamp01((weightedSum) / (PRIOR_COUNT + totalWeight));
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
