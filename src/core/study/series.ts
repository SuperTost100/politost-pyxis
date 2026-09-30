import { shouldClose, shouldOpen, type OpenGap } from "./gaps";
import { masteryFor, type MasteryEvent } from "./mastery";

const DAY = 86_400_000;

export type SeriesEvent = {
  topicId: string;
  at: number;
  score: number;
  scores?: number[];
  kind: "quiz" | "card" | "lesson";
};

function dayStart(at: number): number {
  return Math.floor(at / DAY) * DAY;
}

function weekStart(at: number): number {
  const day = dayStart(at);
  const weekday = new Date(day).getUTCDay();
  return day - ((weekday + 6) % 7) * DAY;
}

export function chartPoints(events: SeriesEvent[], now: number, days = 14) {
  const end = dayStart(now);
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = end - i * DAY;
    const until = day + DAY;
    const counted = events.filter((event) => event.at >= day && event.at < until).length;
    const masteryEvents: MasteryEvent[] = events
      .filter((event) => event.at < until)
      .map((event) => ({
        topicId: event.topicId,
        kind: event.kind,
        score: event.score,
        at: event.at,
      }));
    const scores = Object.values(masteryFor(masteryEvents, until - 1));
    const mastery =
      scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;
    points.push({ day, count: counted, mastery });
  }
  return points;
}

export function weeklyCounts(
  events: SeriesEvent[],
  topicIds: string[],
  now: number,
  weeks = 5,
) {
  const end = weekStart(now);
  const starts = Array.from({ length: weeks }, (_, index) => end - (weeks - 1 - index) * 7 * DAY);
  const counts: Record<string, number[]> = {};
  for (const id of topicIds) counts[id] = Array(weeks).fill(0);
  for (const event of events) {
    const row = counts[event.topicId];
    if (!row) continue;
    const index = starts.indexOf(weekStart(event.at));
    if (index >= 0) row[index] = (row[index] ?? 0) + 1;
  }
  return { weeks: starts, counts };
}

export function paceFacts(bars: Array<{ day: number; count: number }>, now: number) {
  const start = weekStart(now);
  const week = bars.filter((bar) => bar.day >= start).reduce((sum, bar) => sum + bar.count, 0);
  const peak = bars.reduce(
    (best, bar) => (bar.count > best.count ? bar : best),
    bars[0] ?? { day: dayStart(now), count: 0 },
  );
  return { week, peakDay: peak.day, peakCount: peak.count };
}

export function openGaps(events: SeriesEvent[]): OpenGap[] {
  const byTopic = new Map<string, SeriesEvent[]>();
  for (const event of events) {
    if (event.kind !== "quiz") continue;
    const list = byTopic.get(event.topicId) ?? [];
    list.push(event);
    byTopic.set(event.topicId, list);
  }
  const open: OpenGap[] = [];
  for (const [topicId, list] of byTopic) {
    list.sort((a, b) => a.at - b.at);
    const attempts = list.map((event) => ({
      topicId,
      at: event.at,
      scores: event.scores ?? [event.score],
    }));
    let gap: OpenGap | null = null;
    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index];
      if (!attempt) continue;
      if (gap && shouldClose(gap, attempts.slice(index))) gap = null;
      if (!gap && shouldOpen(attempt, false)) gap = { topicId, openedAt: attempt.at };
    }
    if (gap && shouldClose(gap, attempts)) gap = null;
    if (gap) open.push(gap);
  }
  return open;
}
