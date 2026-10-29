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
