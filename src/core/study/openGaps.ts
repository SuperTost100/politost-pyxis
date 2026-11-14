import type Database from "better-sqlite3";
import { reachableTarget } from "../../shared/plan-file";
import { planMastery, planStudied, planTarget, rankedOpenGaps, syncGaps } from "../plans/progress";

/** From most to least serious; the exam page names them Seria, Media and Lieve. */
export const GAP_LEVELS = ["serious", "moderate", "minor"] as const;
export type GapLevel = (typeof GAP_LEVELS)[number];

/** The most gaps one read returns. `total` still counts them all, so the page can say how many it does not show. */
export const OPEN_GAPS_MAX = 100;

/**
 * How serious a gap is, in three levels from the two Pyxis stores. This is the only place that tells them apart.
 * `severity` is the one `gapSeverity` settled (the model said severe, or the topic is under half the target): that is
 * "serious". A minor gap on a topic still under its target is "moderate"; once the topic has reached the target and the
 * misconception remains, it is "minor". `reachedTarget` is the target a topic can reach (`reachableTarget`).
 */
export function gapLevel(severity: "severe" | "minor", mastery: number, reachedTarget: number): GapLevel {
  if (severity === "severe") return "serious";
  return mastery < reachedTarget ? "moderate" : "minor";
}

/**
 * The exam's open gaps for its page: each with its topic, its level and its sentence as stored, most serious first,
 * and `total`, how many there are. It counts the gaps `planGuide` counts per topic, by the same rule
 * (`OPEN_GAPS_WHERE`), and ranks them as `planSeries` does, with the level in place of the two severities: level, then
 * the most linked wrong answers, then the oldest, then id. Like those two it syncs the gap rows first.
 */
export function openGaps(db: Database.Database, planId: string, now = Date.now()) {
  syncGaps(db, planId, now);
  const topics = planMastery(db, planId, now);
  const target = planTarget(db, planId);
  const reached = reachableTarget(target);
  const ranked = rankedOpenGaps(
    db,
    planId,
    { topics, target, studied: planStudied(db, planId) },
    ({ severity, mastery }) => GAP_LEVELS.indexOf(gapLevel(severity, mastery, reached)),
  );
  const titles = new Map(topics.map((topic) => [topic.id, topic.title]));
  return {
    total: ranked.length,
    gaps: ranked.slice(0, OPEN_GAPS_MAX).map((gap) => ({
      gapId: gap.gapId,
      topicId: gap.topicId,
      topicTitle: titles.get(gap.topicId) ?? "",
      level: gapLevel(gap.severity, gap.mastery, reached),
      // Null until the analysis writes one; a sentence of only spaces says nothing either.
      sentence: gap.misconception?.trim() ? gap.misconception : null,
      wrongAnswers: gap.wrongAnswers,
      openedAt: gap.openedAt,
    })),
  };
}
