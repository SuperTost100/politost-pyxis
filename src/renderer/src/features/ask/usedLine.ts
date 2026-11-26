/**
 * The line above an answer that says what it used, as a translation key and its values. The keys live under
 * `ask.used` in the locale files; `wider` picks the variant that says the chat's subject had nothing on the question.
 */
export type UsedLine = { key: string; values: Record<string, string | number> } | null;

/**
 * What a reply from general knowledge says. Nothing relevant found: where Pyxis looked, the whole Library or the files
 * the chat is limited to. Passages found but not cited: that the answer cites no source. Without the note, which a stopped
 * or older reply lacks, only that it cites none.
 */
function generalKey(searched: { found: boolean; where: "library" | "files" } | undefined): string {
  if (!searched) return "generalNoSource";
  if (searched.found) return "generalUnused";
  return searched.where === "files" ? "generalFiles" : "general";
}

type Cited = { sourceId: string; subject?: string | null; attached?: boolean };

export function usedLine(reply: {
  grounding: "sources" | "wider" | "general" | null;
  citations: readonly Cited[];
  /** For a reply from general knowledge: whether the search found passages the answer did not cite, and where it looked. */
  searched?: { found: boolean; where: "library" | "files" };
}): UsedLine {
  if (reply.grounding === "general") return { key: `ask.used.${generalKey(reply.searched)}`, values: {} };
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

/**
 * Whether a reply's substance is an action rather than an answer: it holds a ```pyxis-tool block (cards, a map, a quiz,
 * a proposal) or its turn read the student's own results. The general-knowledge note speaks about where an answer comes
 * from, so it is left off such a reply. Every other reply keeps it, however short, a refusal included.
 */
function isAction(reply: { body?: string; results?: boolean }): boolean {
  return Boolean(reply.results) || (reply.body !== undefined && /^```pyxis-tool\s*$/m.test(reply.body));
}

/**
 * The line kept above an answer, now that the row under it names the sources: one that says the answer comes from
 * general knowledge, or that the chat's subject had nothing on the question, both warnings to read before the answer.
 * The general-knowledge note is left off a reply whose substance is an action (`isAction`).
 */
export function noteLine(reply: Parameters<typeof usedLine>[0] & { body?: string; results?: boolean }): UsedLine {
  const line = usedLine(reply);
  if (!line) return null;
  if (reply.grounding === "general") return isAction(reply) ? null : line;
  return line.values.context === "wider" ? line : null;
}
