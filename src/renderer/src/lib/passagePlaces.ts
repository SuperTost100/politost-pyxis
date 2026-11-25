import { useQueries } from "@tanstack/react-query";
import { invoke } from "./ipc";
import { useSources } from "./queries";
import type { CitedPlace } from "./sourcePlaces";

/** A passage with the passages around it (`sources.passage`). The sources row and the passage's card share it. */
export function passageQuery(passageId: string) {
  return {
    queryKey: ["passage-text", passageId],
    queryFn: () => invoke("sources.passage", { passageId }),
    staleTime: 60000,
    retry: false,
  } as const;
}

/**
 * The places of passages a text cites as [Pn] = `cited[n - 1]`, when the page knows only their ids, as a quiz
 * explanation does: each passage's source and place are read, and the source's title comes from the Library. Until they
 * are read, or for a passage no longer there, the place is listed under its `label`.
 */
export function usePassagePlaces(cited: ReadonlyArray<{ passageId: string; label?: string }>): CitedPlace[] {
  const results = useQueries({ queries: cited.map((cite) => passageQuery(cite.passageId)) });
  const sources = useSources();
  const titles = new Map((sources.data ?? []).map((source) => [source.id, source.title]));
  return cited.map((cite, index) => {
    const row = results[index]?.data?.find((passage) => passage.current);
    return {
      n: index + 1,
      passageId: cite.passageId,
      sourceId: row?.sourceId,
      title: row?.sourceTitle ?? (row ? titles.get(row.sourceId) : undefined),
      page: row?.locator.page,
      slide: row?.locator.slide,
      chapter: row?.locator.chapter,
      section: row?.sectionPath ?? undefined,
      fallbackTitle: cite.label,
    };
  });
}
