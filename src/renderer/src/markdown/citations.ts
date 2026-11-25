import { PASSAGE_MARK, replaceMarkRuns, splitCitationGroups } from "../../../shared/smart-text";
import { mapOutsideCode } from "../../../shared/math-delimiters";

/** Whether a [Pn] mark names a passage the page knows, such as one stored with the reply. */
export type KnownPassage = (passageId: number) => boolean;

/**
 * Turns each [Pn] mark into an empty `cite:` link, which the Markdown view draws as an invisible anchor: the text shows
 * no mark, and the sources row finds the words a passage supports from it. The spaces before a mark go with it, so
 * "volume [P1]." reads "volume." With `known`, a mark for a passage the page does not know (the model cited one the
 * reply never stored) is dropped, since nothing can open it. Without it, every mark is kept by its number. Whitespace
 * is touched only next to a run of marks (`replaceMarkRuns`), so the Markdown keeps its blocks.
 */
export function linkCitations(markdown: string, known?: KnownPassage): string {
  return mapOutsideCode(markdown, (text) =>
    replaceMarkRuns(splitCitationGroups(text), PASSAGE_MARK, (run) =>
      [...run.matchAll(/\[P(\d+)\]/g)]
        .map(([, raw]) => Number(raw))
        .map((id) => (!known || known(id) ? `[](cite:p${id})` : ""))
        .join(""),
    ),
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
