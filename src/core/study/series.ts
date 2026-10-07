import { shouldClose, shouldOpen, type OpenGap } from "./gaps";
import { masteryFor, type MasteryEvent } from "./mastery";

export type SeriesEvent = {
  topicId: string;
  at: number;
  score: number;
  scores?: number[];
  answerKinds?: Array<string | undefined>;
  /** "check": a lesson's quick check; it counts for mastery but never opens or closes a gap. */
  evidenceKind?: "quiz" | "simulation" | "check";
  /** The attempt this event came from and its answers by question id, when recorded; links wrong answers to gaps. */
  attemptId?: string;
  answers?: Array<{ id?: string; score: number }>;
  kind: "quiz" | "card" | "lesson" | "active";
  seconds?: number;
};

function dayStart(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function weekStart(at: number): number {
  const date = new Date(dayStart(at));
  const weekday = date.getDay();
  date.setDate(date.getDate() - ((weekday + 6) % 7));
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isStudied(
  event: SeriesEvent,
): event is SeriesEvent & { kind: "quiz" | "card" | "lesson" } {
  return event.kind !== "active";
}

export function chartPoints(events: SeriesEvent[], now: number, days = 14) {
  const end = dayStart(now);
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(end, -i);
    const until = addDays(day, 1);
    const studied = events.filter(isStudied);
    const counted = studied.filter(
      (event) => event.at >= day && event.at < until,
    ).length;
    const masteryEvents = seriesEvidence(
      studied.filter((event) => event.at < until),
    );
    const scores = Object.values(masteryFor(masteryEvents, until - 1));
    const mastery =
      scores.length === 0
        ? 0
        : scores.reduce((sum, score) => sum + score, 0) / scores.length;
    points.push({ day, count: counted, mastery });
  }
  return points;
}

/** Legacy attempts retain their individual scores; missing answer kinds use quiz weight. */
export function seriesEvidence(events: SeriesEvent[]): MasteryEvent[] {
  return events.flatMap((event) => {
    if (event.kind !== "quiz") return [];
    return (event.scores ?? [event.score]).map((score, index) => ({
      topicId: event.topicId,
      kind: event.evidenceKind ?? "quiz",
      answerKind: event.answerKinds?.[index],
      score,
      at: event.at,
    }));
  });
}

export function weeklyCounts(
  events: SeriesEvent[],
  topicIds: string[],
  now: number,
  weeks = 5,
) {
  const end = weekStart(now);
  const starts = Array.from({ length: weeks }, (_, index) =>
    addDays(end, (index - (weeks - 1)) * 7),
  );
  const counts: Record<string, number[]> = {};
  for (const id of topicIds) counts[id] = Array(weeks).fill(0);
  for (const event of events) {
    if (event.kind === "active") continue;
    const row = counts[event.topicId];
    if (!row) continue;
    const index = starts.indexOf(weekStart(event.at));
    if (index >= 0) row[index] = (row[index] ?? 0) + 1;
  }
  return { weeks: starts, counts };
}

export function paceFacts(
  bars: Array<{ day: number; count: number }>,
  now: number,
  active: Array<{ day: number; seconds: number }> = [],
) {
  const start = weekStart(now);
  const week = bars
    .filter((bar) => bar.day >= start)
    .reduce((sum, bar) => sum + bar.count, 0);
  const timed = active.some((bar) => bar.seconds > 0);
  const peakBars = active.map((bar) => ({ day: bar.day, count: bar.seconds }));
  const source = timed ? peakBars : bars;
  const peak = source.reduce(
    (best, bar) => (bar.count > best.count ? bar : best),
    source[0] ?? { day: dayStart(now), count: 0 },
  );
  return { week, peakDay: peak.day, peakCount: peak.count };
}

export function activeMinutes(events: SeriesEvent[], now: number, days = 14) {
  const end = dayStart(now);
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(end, -i);
    const until = addDays(day, 1);
    const seconds = events
      .filter(
        (event) =>
          event.kind === "active" && event.at >= day && event.at < until,
      )
      .reduce((sum, event) => sum + (event.seconds ?? 0), 0);
    bars.push({ day, seconds });
  }
  const start = weekStart(now);
  const week = bars
    .filter((bar) => bar.day >= start)
    .reduce((sum, bar) => sum + bar.seconds, 0);
  return { bars, weekSeconds: week };
}

/** A gap row the replay already knows: persisted (it has an id) or opened by the replay itself. */
export type TrackedGap = OpenGap & { id?: string; closedAt: number | null; fresh: boolean };

/**
 * Replays a plan's quiz events against its gap rows. A gap opens on an attempt that qualifies (`shouldOpen`) while no
 * gap on the topic is open, and closes at the first session where `shouldClose` holds. `scoresFor` says which of an
 * event's answers count for a gap (a wrong answer linked to another gap does not). Known rows keep their ids and any
 * closing time; the result lists them again with the ones that opened (`fresh`) or closed during the replay.
 */
export function replayGaps(
  events: SeriesEvent[],
  known: Array<OpenGap & { id: string; closedAt: number | null }> = [],
  scoresFor: (gap: TrackedGap, event: SeriesEvent) => number[] = (_gap, event) =>
    event.scores ?? [event.score],
): TrackedGap[] {
  const byTopic = new Map<string, SeriesEvent[]>();
  for (const event of events) {
    if (event.kind !== "quiz" || event.evidenceKind === "check") continue;
    byTopic.set(event.topicId, [...(byTopic.get(event.topicId) ?? []), event]);
  }
  for (const gap of known) if (!byTopic.has(gap.topicId)) byTopic.set(gap.topicId, []);
  const tracked: TrackedGap[] = [];
  for (const [topicId, list] of byTopic) {
    list.sort((a, b) => a.at - b.at);
    const attemptsFor = (gap: TrackedGap) =>
      list.map((event) => ({ topicId, at: event.at, scores: scoresFor(gap, event) }));
    /** When the gap first satisfied the closing rule, or null. */
    const closeTime = (gap: TrackedGap) => {
      const attempts = attemptsFor(gap);
      for (let index = 0; index < attempts.length; index++)
        if (shouldClose(gap, attempts.slice(0, index + 1))) return attempts[index]!.at;
      return null;
    };
    const mine: TrackedGap[] = known
      .filter((gap) => gap.topicId === topicId)
      .map((gap) => {
        const row: TrackedGap = { ...gap, fresh: false };
        row.closedAt = gap.closedAt ?? closeTime(row);
        return row;
      });
    for (const event of list) {
      const covered = mine.some(
        (gap) => gap.openedAt <= event.at && (gap.closedAt == null || gap.closedAt > event.at),
      );
      const attempt = {
        topicId,
        at: event.at,
        scores: event.scores ?? [event.score],
        openScores: (event.scores ?? [event.score]).filter(
          (_score, index) => event.answerKinds?.[index] === "open",
        ),
      };
      if (covered || mine.some((gap) => gap.openedAt === event.at) || !shouldOpen(attempt, false)) continue;
      const row: TrackedGap = { topicId, openedAt: event.at, closedAt: null, fresh: true };
      row.closedAt = closeTime(row);
      mine.push(row);
    }
    tracked.push(...mine);
  }
  return tracked;
}

export function openGaps(events: SeriesEvent[]): OpenGap[] {
  return replayGaps(events)
    .filter((gap) => gap.closedAt == null)
    .map(({ topicId, openedAt }) => ({ topicId, openedAt }));
}
