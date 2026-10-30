/**
 * Runs the save steps of the exam settings page in order (the plan's settings, then the weekly hours), then reads the
 * plan again. When a step fails after an earlier one went through, the plan is still read again, so the page compares
 * the edits left with what is now stored, and the failed step's error is the one reported.
 */
export async function saveThenRefresh(
  steps: Array<() => Promise<unknown>>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  let saved = 0;
  try {
    for (const step of steps) {
      await step();
      saved += 1;
    }
  } catch (error) {
    if (saved > 0) await refresh().catch(() => undefined);
    throw error;
  }
  await refresh();
}

/** The most weekly hours the planner saves. */
export const MAX_WEEKLY_HOURS = 100;

/**
 * What the hours field offers: the planner's estimate, while no hours are saved. The estimate was made for the saved
 * date and goal, so it is withheld while either is edited and unsaved. Above the saving limit it is not a value to
 * offer; "tooMany" lets the page say so.
 */
export function hoursSuggestion(input: {
  needed: number | null;
  saved: number | null;
  planEdited: boolean;
}): { kind: "hours"; hours: number } | { kind: "tooMany" } | null {
  if (input.needed === null || input.saved !== null || input.planEdited) return null;
  return input.needed > MAX_WEEKLY_HOURS ? { kind: "tooMany" } : { kind: "hours", hours: input.needed };
}

/** An accepted suggestion goes when the date or goal it was made for changes; hours the student typed stay. */
export function keptHoursEdit<E extends { value: number | null; suggested?: boolean }>(edit: E | null, planEdited: boolean): E | null {
  return edit?.suggested && planEdited ? null : edit;
}

/**
 * Whether the source picker cannot build its list: the library or the past papers failed to load and there is no
 * earlier copy to show. A failed refetch with data still in hand is not a failure the student needs to see.
 */
export function sourcesUnreadable(
  library: { isError: boolean; data: unknown },
  pastPapers: { isError: boolean; data: unknown },
): boolean {
  return (library.isError && library.data === undefined) || (pastPapers.isError && pastPapers.data === undefined);
}

/**
 * The library sources a plan can add: not already in it and not one of its past papers. Until both lists are known
 * nothing is offered, so a past paper can't be picked in the moment before it would be filtered out.
 */
export function attachableSources<S extends { id: string }>(
  library: S[] | undefined,
  attached: string[],
  pastPapers: { papers: Array<{ sourceIds: string[] }> } | undefined,
): S[] {
  if (!library || !pastPapers) return [];
  return library.filter(
    (source) =>
      !attached.includes(source.id) &&
      !pastPapers.papers.some((paper) => paper.sourceIds.includes(source.id)),
  );
}
