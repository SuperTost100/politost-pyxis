import type Database from "better-sqlite3";
import type { ReminderSummary } from "../../shared/reminder";
import { countDueCards } from "../study/cards";
import { daysUntil } from "./create";

/**
 * What the daily study reminder reports: the flashcards due now across the plans that are built, and the plan to open.
 * That plan is the one with the nearest exam among those with cards due, or the one with the most cards due when none
 * has a date. Null when nothing is due. Reads only, so asking costs the student nothing. Plans still building are left out. Counting goes through
 * `countDueCards`, so whatever it excludes from "due" (suspended or removed cards, archived topics) is excluded here too.
 */
export function reminderSummary(
  db: Database.Database,
  now = Date.now(),
): ReminderSummary | null {
  const plans = db
    .prepare(
      `SELECT id, title, exam_at FROM plans WHERE status != 'building' ORDER BY updated_at DESC, id`,
    )
    .all() as Array<{ id: string; title: string; exam_at: number | null }>;
  const due = plans
    .map((plan) => ({
      plan,
      cards: countDueCards(db, plan.id, now),
      days: plan.exam_at == null ? null : daysUntil(plan.exam_at, now),
    }))
    .filter((entry) => entry.cards > 0);
  if (due.length === 0) return null;
  const upcoming = due
    .filter((entry) => entry.days !== null && entry.days >= 0)
    .sort((a, b) => a.days! - b.days!);
  const chosen = upcoming[0] ?? [...due].sort((a, b) => b.cards - a.cards)[0]!;
  return {
    dueCards: due.reduce((sum, entry) => sum + entry.cards, 0),
    planId: chosen.plan.id,
    planTitle: chosen.plan.title,
    daysToExam: chosen.days !== null && chosen.days >= 0 ? chosen.days : null,
  };
}
