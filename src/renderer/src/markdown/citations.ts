import { splitCitationGroups } from "../../../shared/smart-text";
import { mapOutsideCode } from "./normalizeMathDelimiters";

export type CitationResolver = (passageId: number) => string | undefined;

const ENTITY: Record<string, string> = { "[": "&#91;", "]": "&#93;", "\\": "&#92;" };

/**
 * A section name such as "Esercizi [svolti]" would end the link text early. Its brackets become character references,
 * not backslash escapes, because `\[ ... \]` is display math to normalizeMathDelimiters.
 */
function literal(text: string): string {
  return text.replace(/[[\]\\]/g, (char) => ENTITY[char]!);
}

/**
 * Turns each [Pn] marker into a citation link. With a resolver, a marker it does not know (the model cited a passage the
 * reply never stored) stays plain text, since there is nothing to open. Without one, every marker links by its number.
 */
export function linkCitations(markdown: string, resolver?: CitationResolver): string {
  return mapOutsideCode(markdown, (text) =>
    splitCitationGroups(text).replace(/\[P(\d+)\]/g, (_, raw: string) => {
      const id = Number(raw);
      if (!resolver) return `[P${id}](cite:p${id})`;
      const label = resolver(id);
      return label === undefined ? literal(`[P${id}]`) : `[${literal(label)}](cite:p${id})`;
    }),
  );
}
