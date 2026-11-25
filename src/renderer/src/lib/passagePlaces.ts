import { useQuery } from "@tanstack/react-query";
import { invoke } from "./ipc";
import { citedPassageIds, type CitedPlace } from "./sourcePlaces";

/** A passage with the passages around it (`sources.passage`), for the card that quotes it. */
export function passageQuery(passageId: string) {
  return {
    queryKey: ["passage-text", passageId],
    queryFn: () => invoke("sources.passage", { passageId }),
    staleTime: 60000,
    retry: false,
  } as const;
}

/**
 * The places of the passages a text cites as [Pn] = `cited[n - 1]`, when the page knows only their ids, as a quiz
 * explanation does. Only the passages the text's marks name are read, and only where they sit (`sources.places`), never
 * their text: the card reads the one it quotes. Until they are read, or for a passage no longer there, the place is
 * listed under its `label`.
 */
export function usePassagePlaces(
  cited: ReadonlyArray<{ passageId: string; label?: string }>,
  order: readonly number[],
): CitedPlace[] {
  const ids = citedPassageIds(cited, order);
  const read = useQuery({
    queryKey: ["passage-places", ids],
    queryFn: () => invoke("sources.places", { passageIds: ids }),
    enabled: ids.length > 0,
    staleTime: 60000,
    retry: false,
  });
  const where = new Map((read.data ?? []).map((place) => [place.passageId, place]));
  return cited.map((cite, index) => {
    const place = where.get(cite.passageId);
    return {
      n: index + 1,
      passageId: cite.passageId,
      sourceId: place?.sourceId || undefined,
      title: place?.sourceTitle || undefined,
      page: place?.locator.page,
      slide: place?.locator.slide,
      chapter: place?.locator.chapter,
      section: place?.sectionPath ?? undefined,
      fallbackTitle: cite.label,
    };
  });
}
