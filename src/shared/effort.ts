import tiers from "../../resources/model-tiers.json";

/** Reasoning effort levels from lightest to heaviest. `none` switches reasoning off and is never chosen automatically. */
export const effortScale = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

type TierData = {
  features: Record<string, { tier: string }>;
  unknownFeature: { tier: string };
  effort: Record<string, string>;
};
const data = tiers as unknown as TierData;

/** The effort a task wants: `low` for chat, maps and flashcards, `medium` for lessons and photos, `high` for plans and grading. */
export function taskEffort(feature: string): string {
  const tier = (data.features[feature] ?? data.unknownFeature).tier;
  return data.effort[tier]!;
}

/**
 * The effort a model can give for a wanted level. The wanted level itself when the model lists it. Otherwise the
 * nearest listed one, looking lower first for `low` and `medium` and higher first for `high`, then the other way.
 * `undefined` when the model lists no usable effort.
 */
export function nearestEffort(
  wanted: string,
  listed: readonly string[],
): string | undefined {
  const target = effortScale.indexOf(wanted as (typeof effortScale)[number]);
  if (target < 1) return undefined;
  const ranks = listed
    .map((id) => ({
      id,
      rank: effortScale.indexOf(id as (typeof effortScale)[number]),
    }))
    .filter((entry) => entry.rank > 0);
  const exact = ranks.find((entry) => entry.rank === target);
  if (exact) return exact.id;
  const lower = ranks
    .filter((entry) => entry.rank < target)
    .sort((a, b) => b.rank - a.rank)[0];
  const higher = ranks
    .filter((entry) => entry.rank > target)
    .sort((a, b) => a.rank - b.rank)[0];
  return (wanted === "high" ? (higher ?? lower) : (lower ?? higher))?.id;
}

/** The effort a task gets on a model that lists these efforts, when the student chose none. */
export function automaticEffort(
  feature: string,
  listed: readonly string[],
): string | undefined {
  return nearestEffort(taskEffort(feature), listed);
}

/**
 * The effort the student picked for a task, if any. A task Pyxis chose itself keeps the pick apart from the effort
 * it works out; a task the student pinned stores the pick as its effort.
 */
export function studentEffort(
  row: { auto?: boolean; effort?: string; effortChoice?: string } | undefined,
): string | undefined {
  return row?.auto ? row.effortChoice : row?.effort;
}
