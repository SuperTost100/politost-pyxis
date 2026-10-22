import { foldText } from "../../../shared/fold-text";

/**
 * The test for a search box: whether `text` holds what the student typed, ignoring case, accents and the kind of
 * apostrophe, so "perche" finds "Perché". An empty query matches everything.
 */
export function searchMatcher(query: string): (text: string) => boolean {
  const needle = foldText(query.trim());
  return (text) => foldText(text).includes(needle);
}
