import { useQueries } from "@tanstack/react-query";
import { invoke } from "../../lib/ipc";
import { useSources } from "../../lib/queries";

/** How many of a concept's passages are looked up for the sources it names; the first ones are enough to name them. */
const LOOKED_UP = 4;

export type NodeSource = {
  sourceId: string;
  passageId: string;
  title: string;
  page?: number;
  slide?: number;
};

/** The distinct sources a map concept comes from, read from its first passages, with the first passage of each. */
export function useNodeSources(passageIds: readonly string[]): NodeSource[] {
  const sources = useSources();
  const found = useQueries({
    queries: passageIds.slice(0, LOOKED_UP).map((passageId) => ({
      queryKey: ["source-passage", passageId],
      queryFn: () => invoke("sources.passage", { passageId }),
      staleTime: 60_000,
    })),
  });
  const titles = new Map(
    (sources.data ?? []).map((source) => [source.id, source.title]),
  );
  const result: NodeSource[] = [];
  passageIds.slice(0, LOOKED_UP).forEach((passageId, index) => {
    const rows = found[index]?.data ?? [];
    const row =
      rows.find((item) => item.id === passageId) ??
      rows.find((item) => item.current) ??
      rows[0];
    const title = row && titles.get(row.sourceId);
    if (
      !row ||
      !title ||
      result.some((source) => source.sourceId === row.sourceId)
    )
      return;
    result.push({
      sourceId: row.sourceId,
      passageId,
      title,
      page: row.locator.page,
      slide: row.locator.slide,
    });
  });
  return result;
}
