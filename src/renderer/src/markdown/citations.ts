import { splitCitationGroups } from "../../../shared/smart-text";
import { mapOutsideCode } from "../../../shared/math-delimiters";

export type CitationResolver = (passageId: number) => string | undefined;

const ENTITY: Record<string, string> = { "[": "&#91;", "]": "&#93;", "\\": "&#92;" };

/**
 * A section name such as "Esercizi [svolti]" would end the link text early. Its brackets become character references,
 * not backslash escapes, because `\[ ... \]` is display math to normalizeMathDelimiters.
 */
function literal(text: string): string {
  return text.replace(/[[\]\\]/g, (char) => ENTITY[char]!);
}

/** Chips one run of neighbouring citations may show. */
const CHIPS_PER_RUN = 3;
const CITE_LINK = String.raw`\[[^\]]*\]\(cite:p\d+\)`;
const CITE_RUN = new RegExp(`${CITE_LINK}(?:[ \\t]*[,;]?[ \\t]*${CITE_LINK})*`, "g");

/**
 * Neighbouring citations ("[P1], [P2], [P3]") that name the same section are one chip, and a run shows at most
 * CHIPS_PER_RUN chips: a reply that leans on one chapter would otherwise end every sentence with a row of identical pills.
 * The chip that stays opens the first passage of the run.
 */
function thinCitationRuns(text: string): string {
  return text.replace(CITE_RUN, (run) => {
    const seen = new Set<string>();
    const kept: Array<{ link: string; separator: string }> = [];
    for (const [, link, label, separator] of run.matchAll(/(\[([^\]]*)\]\(cite:p\d+\))([ \t]*[,;]?[ \t]*)/g) as Iterable<
      [string, string, string, string]
    >) {
      if (seen.has(label) || kept.length >= CHIPS_PER_RUN) continue;
      seen.add(label);
      kept.push({ link, separator });
    }
    return kept.map((item, index) => (index < kept.length - 1 ? item.link + item.separator : item.link)).join("");
  });
}

/**
 * Turns each [Pn] marker into a citation link. With a resolver, a marker it does not know (the model cited a passage the
 * reply never stored) stays plain text, since there is nothing to open. Without one, every marker links by its number.
 */
export function linkCitations(markdown: string, resolver?: CitationResolver): string {
  return mapOutsideCode(markdown, (text) =>
    thinCitationRuns(
      splitCitationGroups(text).replace(/\[P(\d+)\]/g, (_, raw: string) => {
        const id = Number(raw);
        if (!resolver) return `[P${id}](cite:p${id})`;
        const label = resolver(id);
        return label === undefined ? literal(`[P${id}]`) : `[${literal(label)}](cite:p${id})`;
      }),
    ),
  );
}

/**
 * A `cite:` link as the passage number it names, or null when the href is not one. With a resolver, only numbers it
 * knows (the passages stored with the reply) count: a model that writes `[x](cite:p9)` for a passage it never had gets
 * no chip. Without one, a number is a position in a list the page owns and every number counts.
 */
export function citedPassage(href: string | undefined, resolver?: CitationResolver): number | null {
  const id = href?.match(/^cite:p(\d+)$/)?.[1];
  if (id === undefined) return null;
  return !resolver || resolver(Number(id)) !== undefined ? Number(id) : null;
}
