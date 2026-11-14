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

/**
 * What is true of one gap, as a fact and not as its absence from a list. A gap that merged into another (PRO-02: the same
 * idea) is not closed by learning: it counts for the gap that absorbed it, so this follows the merges to the last gap and
 * says whether that one is closed. `gapId` in the answer is the gap that counts now, the asked one when it did not merge.
 * It reads the exam's gaps first, as `openGaps` does, since that read is what closes a gap whose answers are right.
 * Null for a gap that does not exist.
 */
export function gapState(db: Database.Database, gapId: string, now = Date.now()): { gapId: string; merged: boolean; closed: boolean } | null {
  const own = db.prepare("SELECT plan_id FROM gaps WHERE id = ?").pluck().get(gapId) as string | undefined;
  if (own === undefined) return null;
  syncGaps(db, own, now);
  let id = gapId;
  // A merge chain is short; the bound only keeps a corrupt loop from hanging a read.
  for (let hops = 0; hops < 32; hops++) {
    const row = db.prepare("SELECT closed_at, merged_into FROM gaps WHERE id = ?").get(id) as
      | { closed_at: number | null; merged_into: string | null }
      | undefined;
    if (!row) return null;
    if (row.closed_at != null && row.merged_into) {
      id = row.merged_into;
      continue;
    }
    return { gapId: id, merged: id !== gapId, closed: row.closed_at != null };
  }
  return null;
}
