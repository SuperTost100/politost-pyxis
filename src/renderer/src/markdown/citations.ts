import { splitCitationGroups } from "../../../shared/smart-text";
import { mapOutsideCode } from "../../../shared/math-delimiters";

/**
 * A run of neighbouring marks ("[P1], [P2]"), with the spaces before it. The commas and semicolons between the marks only
 * separate them, so they go with the run; the sentence's own punctuation after it stays.
 */
const MARK_RUN = /([ \t]*)(\[P\d+\](?:[ \t]*[,;]?[ \t]*\[P\d+\])*)/g;

/** Whether a [Pn] mark names a passage the page knows, such as one stored with the reply. */
export type KnownPassage = (passageId: number) => boolean;

/**
 * Turns each [Pn] mark into an empty `cite:` link, which the Markdown view draws as an invisible anchor: the text shows
 * no mark, and the sources row finds the words a passage supports from it. The spaces before a mark go with it, so
 * "volume [P1]." reads "volume." With `known`, a mark for a passage the page does not know (the model cited one the
 * reply never stored) is dropped, since nothing can open it. Without it, every mark is kept by its number. A run of
 * marks loses the separators between them, so "holds [P1], [P2]." reads "holds.".
 */
export function linkCitations(markdown: string, known?: KnownPassage): string {
  return mapOutsideCode(markdown, (text) =>
    splitCitationGroups(text).replace(MARK_RUN, (_, space: string, run: string, at: number, whole: string) => {
      const links = [...run.matchAll(/\[P(\d+)\]/g)]
        .map(([, raw]) => Number(raw))
        .map((id) => (!known || known(id) ? `[](cite:p${id})` : ""))
        .join("");
      // A mark on a line of its own keeps the line's indentation, which keeps it in its list item.
      return (whole[at - 1] === "\n" ? space : "") + links;
    }),
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
