import { PASSAGE_MARK, replaceMarkRuns, splitCitationGroups } from "../../../shared/smart-text";

/** Whether a [Pn] mark names a passage the page knows, such as one stored with the reply. */
export type KnownPassage = (passageId: number) => boolean;

/**
 * Turns each [Pn] mark into an empty `cite:` link, which the Markdown view draws as an invisible anchor: the text shows
 * no mark, and the sources row finds the words a passage supports from it. The spaces before a mark go with it, so
 * "volume [P1]." reads "volume." A mark for a passage `known` does not name (the model cited one the reply never stored)
 * is dropped, since nothing can open it. Only a view that knows its passages calls this; any other shows a stored text's
 * [Pn] as written. Whitespace
 * is touched only next to a run of marks (`replaceMarkRuns`), so the Markdown keeps its blocks.
 */
export function linkCitations(markdown: string, known: KnownPassage): string {
  return replaceMarkRuns(markdown, PASSAGE_MARK, (run) =>
    [...splitCitationGroups(run).matchAll(/\[P(\d+)\]/g)]
      .map(([, raw]) => Number(raw))
      .map((id) => (known(id) ? `[](cite:p${id})` : ""))
      .join(""),
  );
}

/**
 * A `cite:` link as the passage number it names, or null when the href is not one. With `known`, only numbers it knows
 * count: a model that writes `[x](cite:p9)` for a passage it never had gets no anchor. Without it every number counts.
 */
export function citedPassage(href: string | undefined, known?: KnownPassage): number | null {
  const id = href?.match(/^cite:p(\d+)$/)?.[1];
  if (id === undefined) return null;
  return !known || known(Number(id)) ? Number(id) : null;
}
