import { displayMathLines, holdOpenMath, normalizeMathDelimiters } from "../../../shared/math-delimiters";
import { linkCitations, type CitationResolver } from "./citations";

/**
 * The text a Markdown view hands to react-markdown: citations as links, formulas in one delimiter, display formulas on
 * lines of their own. `writing` says the text is still arriving, so a formula whose closing delimiter has not come yet
 * waits as a placeholder instead of showing as raw source or, for `$$`, as an error.
 */
export function markdownSource(body: string, resolver?: CitationResolver, writing = false): string {
  return displayMathLines(normalizeMathDelimiters(linkCitations(writing ? holdOpenMath(body) : body, resolver)));
}
