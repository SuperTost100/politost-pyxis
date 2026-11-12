/**
 * The line above an answer that says what it used, as a translation key and its values. The keys live under
 * `ask.used` in the locale files; `wider` picks the variant that says the chat's subject had nothing on the question.
 */
export type UsedLine = { key: string; values: Record<string, string | number> } | null;

type Cited = { sourceId: string; subject?: string | null; attached?: boolean };

export function usedLine(reply: {
  grounding: "sources" | "wider" | "general" | null;
  citations: readonly Cited[];
}): UsedLine {
  if (reply.grounding === "general") return { key: "ask.used.general", values: {} };
  if (reply.grounding === null || reply.citations.length === 0) return null;
  // The line counts files: two files cited three times are two sources. The list under it keeps every passage.
  const passages = reply.citations.length;
  const count = new Set(reply.citations.map((cite) => cite.sourceId)).size;
  const context: Record<string, string> = reply.grounding === "wider" ? { context: "wider" } : {};
  const fromLibrary = reply.citations.filter((cite) => !cite.attached);
  if (fromLibrary.length === 0) return { key: "ask.used.attached", values: { count } };
  const subjects = [...new Set(fromLibrary.map((cite) => cite.subject ?? ""))];
  const named = subjects.filter(Boolean);
  // Every cited file belongs to one or two subjects: the line names them. Anything else is "your Library".
  if (fromLibrary.length === passages && named.length === subjects.length) {
    if (named.length === 1) return { key: "ask.used.subject", values: { count, subject: named[0]!, ...context } };
    if (named.length === 2)
      return { key: "ask.used.two", values: { count, first: named[0]!, second: named[1]!, ...context } };
  }
  return { key: "ask.used.library", values: { count, ...context } };
}
